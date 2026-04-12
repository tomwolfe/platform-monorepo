import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const dirs = ['apps/intention-engine/src', 'apps/open-delivery/src', 'apps/table-stack/src'];

function walk(currentDir) {
  if (!fs.existsSync(currentDir)) return;
  const files = fs.readdirSync(currentDir);
  for (const file of files) {
    const filePath = path.join(currentDir, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      walk(filePath);
    } else if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      fixFile(filePath);
    }
  }
}

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');
  let changed = false;

  const loggerNames = ['logger', 'requestLogger', 'sentryLogger'];
  const loggerMethods = ['info', 'warn', 'error', 'debug'];
  
  for (const name of loggerNames) {
    for (const method of loggerMethods) {
      const regex = new RegExp(`${name}\\.${method}\\(\\s*\\{\\s*message:\\s*([\`\"'])([\\s\\S]*?)\\1\\s*,?([\\s\\S]*?)\\}\\s*\\)`, 'g');
      
      content = content.replace(regex, (match, quote, message, rest) => {
        changed = true;
        let otherProps = rest.trim();
        if (otherProps.endsWith(',')) otherProps = otherProps.slice(0, -1).trim();
        
        if (otherProps) {
          return `${name}.${method}(${quote}${message}${quote}, { ${otherProps} })`;
        } else {
          return `${name}.${method}(${quote}${message}${quote})`;
        }
      });

      const regexVar = new RegExp(`${name}\\.${method}\\(\\s*\\{\\s*message:\\s*([^,\"'\`\\s]+)\\s*,?([\\s\\S]*?)\\}\\s*\\)`, 'g');
      content = content.replace(regexVar, (match, messageVar, rest) => {
        changed = true;
        let otherProps = rest.trim();
        if (otherProps.endsWith(',')) otherProps = otherProps.slice(0, -1).trim();
        
        if (otherProps) {
          return `${name}.${method}(${messageVar}, { ${otherProps} })`;
        } else {
          return `${name}.${method}(${messageVar})`;
        }
      });
    }
  }

  if (changed) {
    console.log(`Fixed ${filePath}`);
    fs.writeFileSync(filePath, content);
  }
}

dirs.forEach(walk);
