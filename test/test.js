const deobfuscator2 = require('../deobfuscator2');
const fs = require('fs');
const path = require('path');

let srcPath = "./data/example.js"
let exportPath = path.join(path.dirname(srcPath), path.basename(srcPath, '.js') + '-cleaned.js');
let fsOptions = {
    encoding: 'utf-8'
};
jsCode = fs.readFileSync(srcPath, fsOptions);
let timestamp = Date.now();
let newJsCode = deobfuscator2.optimize(jsCode);
fs.writeFileSync(exportPath, newJsCode, fsOptions);

console.log(`clean ok! ${Date.now() - timestamp}`);