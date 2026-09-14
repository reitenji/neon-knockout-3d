import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, rmSync } from 'node:fs';
rmSync('dist', { recursive: true, force: true });
for (const [command,args] of [['vite',['build','--mode','sites']],['tsup',['src/sites/index.ts','--format','esm','--platform','neutral','--out-dir','dist/server']]]) {
  const result=spawnSync(`node_modules/.bin/${command}`,args,{stdio:'inherit'});
  if(result.status!==0) process.exit(result.status??1);
}
mkdirSync('dist/.openai',{recursive:true});
copyFileSync('.openai/hosting.json','dist/.openai/hosting.json');
