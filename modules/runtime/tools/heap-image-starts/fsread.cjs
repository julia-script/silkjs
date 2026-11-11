const fs = require('node:fs'); const s = fs.readFileSync(__filename, 'utf8'); console.log(s.length, JSON.stringify({a: [1, 2, 3]}), process.argv.length, Buffer.from('hi').toString('hex'));
