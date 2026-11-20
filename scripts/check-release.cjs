process.argv.splice(2,0,'--check');
require('./import-release.cjs');
