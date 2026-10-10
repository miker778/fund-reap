// Compila contratos/Permisos.sol con solc-js y deja abi + bytecode en contratos/Permisos.json.
const solc = require('solc'); const fs = require('fs'); const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '../contratos/Permisos.sol'), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: { 'Permisos.sol': { content: src } }, settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } })));
const errs = (out.errors || []).filter(e => e.severity === 'error'); if (errs.length) { console.error(errs.map(e => e.formattedMessage).join('\n')); process.exit(1); }
const c = out.contracts['Permisos.sol'].Permisos;
fs.writeFileSync(path.join(__dirname, '../contratos/Permisos.json'), JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1));
console.log('ok', c.evm.bytecode.object.length / 2, 'bytes');
