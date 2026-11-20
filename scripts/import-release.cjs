// Run the pinned importer with the platform Python command.
const {spawnSync}=require('node:child_process');
const {join}=require('node:path');
const child=spawnSync(process.platform==='win32'?'python':'python3',[join(__dirname,'import_release.py'),...process.argv.slice(2)],{stdio:'inherit'});
if(child.error){console.error(child.error.message);process.exit(1);}
process.exit(child.status??1);
