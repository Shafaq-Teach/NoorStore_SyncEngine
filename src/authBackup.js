/**
 * WhatsApp Auth Backup & Restore via Supabase
 * 
 * Cloud platforms (Render, Railway, etc.) have ephemeral filesystems.
 * Every redeploy or restart wipes ./auth_info_baileys.
 * 
 * This module:
 * 1. On boot: Downloads the latest auth backup from Supabase and restores it
 * 2. After QR scan / creds update: Zips auth_info_baileys and uploads to Supabase
 * 
 * Storage: Supabase table `reviews` row id=999998, column `comment` = base64 zip
 */

import { createClient } from '@supabase/supabase-js';
import { CONFIG } from './config.js';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);
const AUTH_DIR = './auth_info_baileys';
const AUTH_BACKUP_ROW_ID = 999998;

/**
 * Restore auth_info_baileys from Supabase on boot (if local dir is empty/missing)
 */
export async function restoreAuthFromCloud() {
  // If auth dir already exists with files, skip restore
  if (fs.existsSync(AUTH_DIR)) {
    const files = fs.readdirSync(AUTH_DIR);
    if (files.length > 5) {
      console.log(`[AuthBackup] ✅ Local auth already exists (${files.length} files). Skipping cloud restore.`);
      return true;
    }
  }

  console.log('[AuthBackup] 🔍 Checking Supabase for auth backup...');
  
  try {
    const { data, error } = await supabase
      .from('reviews')
      .select('comment')
      .eq('id', AUTH_BACKUP_ROW_ID)
      .maybeSingle();

    if (error || !data || !data.comment) {
      console.log('[AuthBackup] ⚠️ No cloud backup found. Will need fresh QR scan.');
      return false;
    }

    const backup = JSON.parse(data.comment);
    if (!backup || !backup.files || !Array.isArray(backup.files)) {
      console.log('[AuthBackup] ⚠️ Invalid backup format. Will need fresh QR scan.');
      return false;
    }

    // Recreate auth directory
    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    let restored = 0;
    for (const file of backup.files) {
      try {
        const filePath = path.join(AUTH_DIR, file.name);
        fs.writeFileSync(filePath, Buffer.from(file.data, 'base64'));
        restored++;
      } catch (e) {
        // skip individual file errors
      }
    }

    console.log(`[AuthBackup] ✅ Restored ${restored}/${backup.files.length} auth files from Supabase cloud backup!`);
    console.log(`[AuthBackup] 📅 Backup timestamp: ${backup.timestamp || 'unknown'}`);
    return restored > 0;
  } catch (err) {
    console.log('[AuthBackup] ⚠️ Cloud restore error:', err.message);
    return false;
  }
}

/**
 * Backup auth_info_baileys to Supabase after successful connection
 * Only backs up essential credential files (not all 1200+ session files)
 */
export async function backupAuthToCloud() {
  if (!fs.existsSync(AUTH_DIR)) {
    console.log('[AuthBackup] No auth dir to backup.');
    return false;
  }

  try {
    const allFiles = fs.readdirSync(AUTH_DIR);
    
    // Only backup essential credential files (creds.json + app-state-sync-key files)
    // These are the ones needed to restore a session without re-scanning QR
    const essentialPatterns = ['creds.json', 'app-state-sync-key', 'pre-key', 'sender-key', 'session-'];
    const filesToBackup = allFiles.filter(f => {
      return essentialPatterns.some(p => f.startsWith(p) || f.includes(p));
    });

    // If too few essential files, backup all small files
    const targetFiles = filesToBackup.length > 3 ? filesToBackup : allFiles;
    
    const files = [];
    let totalSize = 0;
    const MAX_SIZE = 400 * 1024; // 400KB limit for Supabase text column

    for (const fileName of targetFiles) {
      const filePath = path.join(AUTH_DIR, fileName);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size > 50 * 1024) continue; // skip dirs and large files
        
        const content = fs.readFileSync(filePath);
        const b64 = content.toString('base64');
        totalSize += b64.length;
        
        if (totalSize > MAX_SIZE) break; // don't exceed column size limit
        
        files.push({ name: fileName, data: b64 });
      } catch (e) {
        // skip
      }
    }

    if (files.length === 0) {
      console.log('[AuthBackup] No auth files to backup.');
      return false;
    }

    const backup = {
      files,
      fileCount: files.length,
      timestamp: new Date().toISOString(),
      totalFiles: allFiles.length
    };

    const payload = JSON.stringify(backup);

    // Upsert to reviews table
    const row = {
      id: AUTH_BACKUP_ROW_ID,
      product_id: 1,
      user_name: '__AUTH_BACKUP__',
      comment: payload,
      rating: 5,
      timestamp: Date.now()
    };

    const { error } = await supabase.from('reviews').upsert([row]);
    
    if (error) {
      console.log('[AuthBackup] ⚠️ Supabase upsert error:', error.message);
      return false;
    }

    console.log(`[AuthBackup] ☁️ Backed up ${files.length} essential auth files to Supabase (${(payload.length / 1024).toFixed(1)} KB)`);
    return true;
  } catch (err) {
    console.log('[AuthBackup] Backup error:', err.message);
    return false;
  }
}
