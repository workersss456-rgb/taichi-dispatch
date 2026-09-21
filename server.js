const path = require('path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const api = require('./routes/api');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', api);

db.init()
  .then(() => app.listen(config.port, () => console.log(`太綺派工通已啟動：http://localhost:${config.port}`)))
  .catch((err) => {
    console.error('🚨 資料庫初始化失敗，伺服器無法啟動：', err.message);
    process.exit(1);
  });
