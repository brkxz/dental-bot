FROM node:18-alpine

# Dependencias del sistema para Baileys (native crypto/sharp)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    git \
    libc6-compat

WORKDIR /app

# Instalar dependencias (npm install es más tolerante que npm ci)
COPY package.json ./
RUN npm install --only=production --no-audit --no-fund

# Copiar código fuente
COPY . .

# Crear directorios necesarios
RUN mkdir -p /tmp/data/auth_info_baileys /tmp/data/logs/conversaciones

# Variables de entorno por defecto (Fly.io las sobreescribe)
ENV NODE_ENV=production
ENV DATA_DIR=/tmp/data
ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]
