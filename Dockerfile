FROM node:20-slim

WORKDIR /app

# Copy package files first for better Docker cache
COPY package.json package-lock.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy source code
COPY src/ ./src/
COPY target_group.json ./

# Create empty products_db if needed
RUN echo "[]" > products_db.json

# Expose the port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Start the sync engine
CMD ["node", "src/index.js"]
