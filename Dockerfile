FROM node:18-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY index.js ./
COPY providers/ ./providers/
COPY public/ ./public/

ENV PORT=7860

EXPOSE 7860

CMD ["node", "index.js"]