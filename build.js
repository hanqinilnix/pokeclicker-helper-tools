// Concatenates src/*.js into the distributable userscript.
//
// A userscript manager installs one file, so the modules are joined at build
// time rather than pulled in with @require: @require caches each URL separately
// and only refetches on a version bump, which makes local editing painful and
// leaves the pieces able to drift out of sync with each other.
//
// Everything lands in one IIFE scope, exactly as it did before the split, so
// the modules share state through plain closure variables and no export/import
// plumbing is needed. Order matters only for the handful of statements that run
// at load time; functions may reference anything, since nothing is called until
// boot().
//
//   node build.js            build
//   node build.js --check    verify the checked-in bundle is up to date

const fs = require('fs');
const path = require('path');

const SOURCE_DIR = path.join(__dirname, 'src');
const OUTPUT_PATH = path.join(__dirname, 'pokeclicker-helper.user.js');

// core first (constants and helpers); panel before the modules that register
// toggles into it; boot last (it calls boot()). Registration order is also the
// order the switches appear in the card.
const MODULE_ORDER = [
    'core.js',
    'panel.js',
    'auto-clicker.js',
    'frontier-restart.js',
    'crawler.js',
    'safari.js',
    'mining.js',
    'hatchery.js',
    'bulk-selling.js',
    'boot.js',
];

const build = () => {
    const header = fs.readFileSync(path.join(SOURCE_DIR, 'header.txt'), 'utf8');

    const banner = (name) => '    /* ===================== '
        + name.replace('.js', '').padEnd(14)
        + ' ===================== */\n';

    const body = MODULE_ORDER.map((name) => {
        const modulePath = path.join(SOURCE_DIR, name);
        if (!fs.existsSync(modulePath)) {
            throw new Error('missing module: src/' + name);
        }
        const source = fs.readFileSync(modulePath, 'utf8');
        // Each module opens with a plain top-of-file comment describing it; that
        // is for readers of the module, not of the bundle, so it is dropped and
        // replaced with a banner.
        // \r? matters: without it a CRLF checkout keeps the comment and the bundle
        // stops matching a fresh build.
        const withoutFileComment = source.replace(/^(\/\/[^\n]*\r?\n)+\r?\n/, '');
        return banner(name) + withoutFileComment.replace(/\n+$/, '') + '\n';
    }).join('\n');

    return header + "(function () {\n    'use strict';\n\n" + body + '})();\n';
};

const output = build();

if (process.argv.includes('--check')) {
    const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8') : '';
    if (current !== output) {
        console.error('pokeclicker-helper.user.js is stale — run: node build.js');
        process.exit(1);
    }
    console.log('bundle is up to date');
} else {
    fs.writeFileSync(OUTPUT_PATH, output);
    const lines = output.split('\n').length;
    console.log('built pokeclicker-helper.user.js (' + lines + ' lines from ' + MODULE_ORDER.length + ' modules)');
}
