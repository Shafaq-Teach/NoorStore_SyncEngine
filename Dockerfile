FROM node:20-slim

# Set up non-root user (compatible with Hugging Face, Railway, Render, etc.)
RUN useradd -m -u 1000 user
WORKDIR /app

# Copy dependency files
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy all source files
COPY --chown=user:user . .

# Grant permissions to user
RUN chown -R user:user /app

USER user
ENV PORT=7860
EXPOSE 7860 3000

CMD ["node", "src/index.js"]
