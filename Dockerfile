FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Data directory
RUN mkdir -p /data/files

ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

CMD ["bun", "run", "src/index.ts"]
