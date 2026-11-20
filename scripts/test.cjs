const {spawnSync}=require('node:child_process');
const {readdirSync}=require('node:fs');
const {join}=require('node:path');
const root=join(__dirname,'..');
for(const [command,args] of [[process.platform==='win32'?'python':'python3',['-m','unittest','discover','-s','tests']],[process.execPath,['--test',...readdirSync(join(root,'tests')).filter(name=>name.endsWith('.test.cjs')).map(name=>join('tests',name))]]]){
 const child=spawnSync(command,args,{cwd:root,stdio:'inherit'});if(child.error){console.error(child.error.message);process.exit(1);}if(child.status!==0)process.exit(child.status??1);
}
