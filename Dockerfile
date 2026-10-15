FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY server.mjs auth.mjs chat.mjs whatsapp.mjs wa-admin.mjs proveedores.mjs ajustes.mjs db.mjs guia.mjs usuarios.mjs admin.mjs reportes.mjs n8n.mjs ritmo.mjs app-schema.sql grants.sql ./
COPY public ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.mjs"]
