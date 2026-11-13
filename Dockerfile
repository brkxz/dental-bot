FROM node:18-alpine

# Dependencias del sistema para Baileys + git para npm
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    libc6-compat \
    openssl

WORKDIR /app

# Copiar package.json e instalar dependencias
COPY package.json package-lock.json* ./
RUN npm install --production --no-audit --no-fund

# Copiar código fuente
COPY . .

# Crear directorios necesarios
RUN mkdir -p /tmp/data/auth_info_baileys /tmp/data/logs/conversaciones

# Variables de entorno
ENV NODE_ENV=production
ENV DATA_DIR=/tmp/data
ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]
