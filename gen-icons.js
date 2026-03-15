// Generuje PNG ikony z icon.svg (spustit: node gen-icons.js)
const fs = require('fs');
const path = require('path');

async function run() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch (e) {
    console.error('Nainstalujte sharp: npm install sharp');
    process.exit(1);
  }
  const svg = fs.readFileSync(path.join(__dirname, 'icon.svg'));
  for (const size of [16, 32, 192, 512]) {
    await sharp(svg)
      .resize(size, size)
      .png()
      .toFile(path.join(__dirname, `icon-${size}.png`));
    console.log(`Vytvořeno icon-${size}.png`);
  }
  console.log('Hotovo.');
}

run().catch(e => { console.error(e); process.exit(1); });
