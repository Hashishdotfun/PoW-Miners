const oldIdl = require('../target/idl/pow_privacy.json');
const newIdl = require('../target/idl/pow_privacy_new.json');
const oldIx = oldIdl.instructions.find(i => i.name === 'submit_block_private');
const newIx = newIdl.instructions.find(i => i.name === 'submit_block_private');
console.log('OLD accounts:');
oldIx.accounts.forEach(a => console.log('  ', a.name));
console.log('\nNEW accounts:');
newIx.accounts.forEach(a => console.log('  ', a.name));
const oldNames = new Set(oldIx.accounts.map(a=>a.name));
const newNames = new Set(newIx.accounts.map(a=>a.name));
console.log('\nREMOVED:');
for (const n of oldNames) { if (!newNames.has(n)) console.log('  -', n); }
console.log('ADDED:');
for (const n of newNames) { if (!oldNames.has(n)) console.log('  +', n); }
