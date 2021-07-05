const fs = require('fs');
const path = require('path');
const deobfuscator2 = require('../deobfuscator2');
const EXTNAME = '.js';
const fsOptions = {
    encoding: 'utf-8'
};

// param
let argv = process.argv;
if (argv.length < 3) {
    console.log('Please input the file');
    return;
}

let srcPath = argv[2];

// Check file extension
let currentExtname = path.extname(srcPath);
if (currentExtname !== EXTNAME) {
    console.log(`Unsupported extension: ${currentExtname}`);
    return;
}

let jsCode = fs.readFileSync(srcPath, fsOptions);
let newJsCode = deobfuscator2.optimize(jsCode);
let outPath = path.join(path.dirname(srcPath), path.basename(srcPath, EXTNAME) + '-cleaned' + EXTNAME);
fs.writeFileSync(outPath, newJsCode, fsOptions);

// finish
console.log('clean ok!');