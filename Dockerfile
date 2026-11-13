FROM node:18-slim

# Instalar herramientas de build + git
RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends \
    python3 \
    python-is-python3 \
    make \
    g++ \
    git \
    openssl \
    ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Forzar HTTPS para git (evita bloqueos SSH en la nube)
RUN git config --global url."https://github.com/".insteadOf git@github.com: && \
    git config --global url."https://github.com/".insteadOf ssh://git@github.com/ && \
    git config --global url."https://".insteadOf git://

# Instalar dependencias (sin package-lock para respetar overrides)
COPY package.json ./
RUN npm install --no-audit --no-fund

# Copiar código fuente
COPY . .

# Crear directorios necesarios
RUN mkdir -p /tmp/data/auth_info_baileys /tmp/data/logs/conversaciones

ENV NODE_ENV=production
ENV DATA_DIR=/tmp/data
ENV PORT=8080

EXPOSE 8080

CMD ["node", "index.js"]
