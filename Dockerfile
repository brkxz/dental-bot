FROM node:18-slim

# Dependencias del sistema
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    git \
    openssl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Forzar HTTPS en lugar de SSH para git
RUN git config --global url."https://github.com/".insteadOf git@github.com: && \
    git config --global url."https://github.com/".insteadOf ssh://git@github.com/

# Instalar dependencias
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund

# Copiar código fuente
COPY . .

# Crear directorios necesarios
RUN mkdir -p /tmp/data/auth_info_baileys /tmp/data/logs/conversaciones

ENV NODE_ENV=production
ENV DATA_DIR=/tmp/data
ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]
