FROM node:18-alpine

# Dependencias del sistema para Baileys
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git

WORKDIR /app

# Instalar dependencias primero (cache de capas)
COPY package*.json ./
RUN npm ci --only=production

# Copiar código fuente
COPY . .

# Crear directorio de datos persistentes
RUN mkdir -p /data/auth_info_baileys /data/logs/conversaciones

# Variables de entorno
ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000

EXPOSE 3000

CMD ["node", "index.js"]

