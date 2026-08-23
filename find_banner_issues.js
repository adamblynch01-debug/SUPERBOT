// Script to find all places where brandEmbed is used and send happens
const fs = require('fs');

const content = fs.readFileSync('index.js', 'utf-8');
const lines = content.split('\n');

console.log('Finding all brandEmbed usage followed by sends...\n');

for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('brandEmbed(')) {
    console.log(`Line ${i + 1}: ${lines[i].trim()}`);

    // Look ahead for .send or .reply within next 20 lines
    for (let j = i; j < Math.min(i + 20, lines.length); j++) {
      if (lines[j].includes('.send(') && !lines[j].includes('withBanner(')) {
        console.log(`  → Line ${j + 1} NEEDS FIX: ${lines[j].trim()}`);
      }
    }
    console.log('');
  }
}
