FROM node:20-alpine
WORKDIR /app
COPY package.json server.js collections.json telegram_gift_card.html ./
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server.js"]
