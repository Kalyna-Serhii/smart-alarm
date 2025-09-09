FROM node:20

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install

COPY . .

RUN npm rebuild better-sqlite3

CMD ["node", "src/app.js"]
