import { pushCloudSyncState } from './supabaseSync.js';

async function test() {
  await pushCloudSyncState({
    telegramStatus: 'CONNECTED',
    whatsappStatus: 'CONNECTED',
    latestQrDataUrl: null,
    groups: [{ id: '1203630248@g.us', subject: 'Noor Store ??????????' }],
    selectedGroup: { id: '1203630248@g.us', subject: 'Noor Store ??????????' },
    logs: [{ time: '22:15', name: 'iPhone 16 Pro Max', price: 8999, supabaseSuccess: true, whatsappSuccess: true, whatsappGroup: 'Noor Store ??????????' }]
  });
  console.log('Push complete!');
}
test();
