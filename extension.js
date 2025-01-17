const vscode = require("vscode");
const fs = require("fs");
const fsp = fs.promises;
const cpm = require("child_process");
const path = require("path");
const glob = require("glob");
const pkg = require("./package.json");
const util = require("./src/util");
const CONSTANTS = require('./src/CONSTANTS');

const cmdPrefix = "droidscript-docs.";
const titlePrefix = "DroidScript Docs: ";
// default displayed commands
const commands = ["generateDocs", "preview", "updatePages", "upload", "filter", "allCommands"];

/** @type {CmdMap} */
const cmdMap = Object.assign({}, ...pkg.contributes.commands.map(c =>
    ({ [c.command.replace(cmdPrefix, "")]: c.title.replace(titlePrefix, "") })
));

let folderPath = "";
let generateJSFilePath = "files/generate.js";
let jsdocParserFilePath = "files/jsdoc-parser.js";
let updatePagesFilePath = "files/updatePages.js";
let markdownGenFilePath = "files/markdown-generator.js";
let confPath = "files/conf.json";

/** @type {vscode.StatusBarItem} */
let generateBtn;
/** @type {vscode.WebviewPanel} */
let webViewPanel;

let filter = { lang: "*", ver: "*", scope: "*", name: "*" };
let lastCommand = "", working = false;
let LANG = "en";

/** @type {DSConfig} */
let conf;
/** @type {DSExtConfig} */
let dsconf;
/** @type {Obj<string>} */
let tnames = {};

const chn = vscode.window.createOutputChannel("Docs Debug");

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    if (!vscode.workspace.workspaceFolders) return;
    const cw = vscode.workspace.workspaceFolders[0];
    if (!cw || !cw.name) return;

    folderPath = cw.uri.fsPath;
    generateJSFilePath = path.join(folderPath, generateJSFilePath);
    jsdocParserFilePath = path.join(folderPath, jsdocParserFilePath);
    updatePagesFilePath = path.join(folderPath, updatePagesFilePath);
    markdownGenFilePath = path.join(folderPath, markdownGenFilePath);
    confPath = path.join(folderPath, confPath);

    if (!fs.existsSync(generateJSFilePath)) return;
    if (!fs.existsSync(jsdocParserFilePath)) return;
    if (!fs.existsSync(confPath)) return;
    readConf();

    generateBtn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
    generateBtn.command = cmdPrefix + "selectCommand";
    generateBtn.text = "$(tools) Generate Docs";
    generateBtn.tooltip = "Select Command";
    generateBtn.show();

    /** @type {(cmd:string, cb:(...args:any[])=>any) => void} */
    const subscribe = (cmd, cb) => {
        context.subscriptions.push(vscode.commands.registerCommand(cmdPrefix + cmd, (...args) => (lastCommand = cmd, readConf(), cb(...args))));
    };

    subscribe("generateDocs", () => generate({ clear: true }));
    subscribe("clean", () => generate({ clean: true }));
    subscribe("update", () => generate({ update: true }));
    subscribe("updatePages", () => execFile(updatePagesFilePath));
    subscribe("markdownGen", () => execFile(markdownGenFilePath));
    subscribe("addVariant", addVariant);
    subscribe("upload", uploadDocs);
    subscribe("uploadFile", uploadFile);
    subscribe("setVersion", setVersion);
    subscribe("selectCommand", selectCommand);
    subscribe("allCommands", selectCommand.bind(null, true));
    subscribe("filter", chooseFilter);
    subscribe("preview", openWithLiveServer);
    subscribe("generateFile", generateFile);

    // vscode.workspace.onDidSaveTextDocument(event => generateFile(event.uri));

    vscode.languages.registerCompletionItemProvider('javascript', { provideCompletionItems });
    vscode.languages.registerCompletionItemProvider('markdown', { provideCompletionItems });

    getAllMarkupFiles();
}

// This method is called when your extension is deactivated
function deactivate() {
    generateBtn.dispose();
    webViewPanel.dispose();
    vscode.commands.executeCommand('livePreview.end');
}

async function readConf() {
    await util.loadJson(confPath)
        .then(cfg => { conf = cfg; Object.assign(tnames, conf.tname, conf.tdesc); })
        .catch(e => { vscode.window.showErrorMessage(e); });
}

async function readDSConf() {
    await util.loadJson(CONSTANTS.DSCONFIG)
        .then(cfg => { dsconf = cfg; })
        .catch(e => { vscode.window.showErrorMessage(e); });
}

async function saveDSConf() {
    await util.saveJson(CONSTANTS.DSCONFIG, dsconf)
        .catch(e => { vscode.window.showErrorMessage(e); });
}

function getAllMarkupFiles() {
    const p = path.join(folderPath, "files", "markup", LANG);
    let fdrs = fs.readdirSync(p);
    fdrs = fdrs.filter(m => {
        let g = fs.statSync(path.join(p, m));
        return g.isDirectory();
    });
    /** @type {Array<String>} */
    const mkfls = [];
    fdrs.forEach(m => mkfls.push(...fs.readdirSync(path.join(p, m))));
    vscode.commands.executeCommand('setContext', 'droidscript-docs.markupfiles', mkfls);
}

const generateOptions = { clean: false, clear: false, update: false, add: "", set: "", value: "", gen: true, filter: /** @type {Partial<typeof filter>} */ (filter) };
/** @param {Partial<typeof generateOptions>} [options] */
async function generate(options = generateOptions) {
    options = Object.assign({}, generateOptions, options);
    let filter = Object.assign({ lang: "*", ver: "*", scope: "*", name: "*" }, options.filter);

    working = true;
    generateBtn.text = "$(sync~spin) Docs";
    generateBtn.tooltip = "Task: " + cmdMap[lastCommand];

    chn.clear();
    chn.show();

    if ("generateDocs,generateFile,update,".includes(lastCommand + ",")) {
        const args = filter.name == "*" ? undefined : `-p=${filter.scope}.${filter.name}`;
        if (await execFile(jsdocParserFilePath, args)) return;
        vscode.commands.executeCommand('livePreview.end');
    }

    let optionStr = "";
    const filters = [filter.lang, filter.scope, filter.name];
    const filterStr = filters.filter(f => f != "*").join(".");
    if (options.clean) optionStr += " -C";
    if (options.clear) optionStr += " -c";
    if (!options.gen) optionStr += " -n";
    if (options.update) optionStr += " -u";
    if (options.add) optionStr += ` -a${options.add}="${options.value}"`;
    if (options.set) optionStr += ` -s${options.set}="${options.value}"`;
    if (filter.ver != "*") optionStr += ` -v=${filter.ver}`;

    await execFile(generateJSFilePath, `${optionStr} "${filterStr}"`);

    working = false;
    generateBtn.text = "$(check) Docs: Done";
    if ("generateDocs,generateFile,update,".includes(lastCommand + ",")) openWithLiveServer(filter);
    updateTooltip();
}

/** @type {(file:string, args?:string) => Promise<number>} */
async function execFile(file, args = "") {
    // Execute the Docs/files/jsdoc-parser.js file
    chn.appendLine(`$ node ${file} ${args}`);
    return await processHandler(cpm.exec(`node ${file} ${args}`))
        .then(() => 0, ([code, error]) => {
            vscode.window.showErrorMessage(`Exit Code ${code}: ${error.message || error}`);
            updateTooltip();
            return -1;
        });
}

/** @type {(cp:cpm.ChildProcess) => Promise<[number, Error]>} */
function processHandler(cp) {
    cp.stdout?.on("data", data => chn.append(data.replace(/\x1b\[[0-9;]*[a-z]/gi, '')));
    cp.stderr?.on("data", data => chn.append(data.replace(/\x1b\[[0-9;]*[a-z]/gi, '')));
    /** @type {Error} */
    let error;
    return new Promise((res, rej) => {
        cp.on("error", e => (error = e, chn.append("$ Error: " + e)));
        cp.on("exit", (code, sig) => (chn.append(`$ Exit Code: ${code}` + (sig ? ` (${sig})` : '')),
            (error || code ? rej : res)([code || 0, error || "Process returned non-null exit code.\nCheck the debug log for details."])));
    });
}

function updateTooltip() {
    const filterStr = `language: ${filter.lang}\nversion: ${filter.ver}\nscope: ${filter.scope}\nname: ${filter.name}`;
    generateBtn.tooltip = `Generate Filter\n${filterStr}`;
}

async function addVariant() {
    const ph = { Language: "en (English)", Version: "v257", Scope: "app (Reference)" };
    /** @ts-ignore @type {keyof typeof ph | undefined} */
    const variant = await vscode.window.showQuickPick(Object.keys(ph), { title: "Pick Variant" });
    if (!variant) return;

    /** @param {string} value */
    const validateInput = (value) => {
        const m = value.match(/^(\w*)(\s+\(?(.*)\)?)?$/);
        if (!m) return "Invalid Input";
        if (variant == "Language") {
            if (!m[1] || !/^[a-z][a-z]$/.test(m[1])) return "Language code must have 2 lower case letters";
            if (!m[3] || !/^\w{4,}$/.test(m[3])) return "Missing name after language code";
        }
        else if (variant == "Version") {
            // supports alpha, beta and patch versions, although noone might ever use those
            if (!m[1] || !/^v\d{3}([ab]\d(_p\d)?)?$/.test(m[1])) return "Version must start with a 'v' followed by 1-3 digits";
        }
        else if (variant == "Scope") {
            if (!m[1] || !/^[a-z][a-z0-9]{2,}$/i.test(m[1])) return "Scope namespace must have at least 3 digits";
            if (!m[3] || !/^.{4,}$/.test(m[3])) return "Missing title after scope namespace";
        }
        else return "How did you get in here?!";

        return undefined;
    }
    let value = await vscode.window.showInputBox({ title: "Enter " + variant, value: ph[variant], validateInput });
    if (!value) return;

    value = value?.replace(/[\s()]+/g, " ").replace(" ", "=");
    await generate({ add: variant[0].toLowerCase(), value, gen: false });
    readConf();
}

/** @param {vscode.Uri} uri */
async function uploadFile(uri) {
    const fileFilter = util.getFileFilter(uri);
    if (fileFilter) uploadDocs(fileFilter);
}

async function enterServerIP() {
    let serverIP = dsconf.serverIP;
    dsconf.PORT ||= CONSTANTS.PORT;
    if (serverIP && !dsconf.serverIP.includes(':'))
        serverIP = `${dsconf.serverIP}:${dsconf.PORT}`;
    const validPort = /^\d+$/.test(dsconf.PORT);

    vscode.window.showInformationMessage("Enter DS Server IP");
    let newIP = await vscode.window.showInputBox({
        title: "Enter DS Server IP",
        value: serverIP || '',
        placeHolder: '192.168.178.42:' + CONSTANTS.PORT,
        validateInput: ip => {
            if (util.isValidIPWithPort(ip)) return;
            return util.isValidIP(ip) ? (validPort ? null : "Invalid IP") : "Missing Port";
        }
    });

    if (!newIP) { vscode.window.showErrorMessage("Server IP not updated!"); return; }
    if (!util.isValidIPWithPort(newIP)) newIP += ":" + dsconf.PORT;
    if (!util.isValidIPWithPort(newIP)) { vscode.window.showErrorMessage("Server IP not updated!"); return; }
    dsconf.serverIP = newIP;
    saveDSConf();
    vscode.window.showInformationMessage("Server IP updated!");
}

/** @param {Partial<typeof filter>} sfilter */
async function uploadDocs(sfilter = filter) {
    await readDSConf();
    if (!util.isValidIPWithPort(dsconf.serverIP)) { enterServerIP(); return; }

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Uploading docs`,
    }, async (progress, token) => {

        const filter = Object.assign({ lang: "*", ver: "*", scope: "*", name: "*" }, sfilter);
        if (filter.lang == "*") filter.lang = Object.keys(conf.langs)[0];
        if (filter.ver == "*") filter.ver = conf.vers[0];

        const cwd = path.join(folderPath, "out", "docs" + (filter.lang == 'en' ? '' : `-${filter.lang}`), filter.ver);
        // a+b: a/b,  a+*: a/*,  *+b: */b,  *+*: **
        const docsGlob = `${filter.scope}/${filter.name}`.replace('*/*', '**');
        const files = await glob.glob(docsGlob, { cwd, posix: true, nodir: true });

        // reverse() as glob is somewhat reverse sorted
        await util.batchPromises(files.reverse(), async (file, index, data) => {
            if (token.isCancellationRequested) throw new Error("Cancelled");

            const dest = '.edit/docs/' + file;
            const folder = dest.slice(0, dest.lastIndexOf('/'));
            const name = path.basename(file);

            const fileStream = fs.createReadStream(path.join(cwd, file));
            const res = await util.uploadFile(dsconf.serverIP, fileStream, folder, name);

            if (res.status !== "ok") throw Error(JSON.stringify(res));
            progress.report({ increment: 100 / data.length, message: file });
        })
            .then(() => { vscode.window.showInformationMessage("Upload Successful"); })
            .catch(e => {
                if (e.code == "ETIMEDOUT") enterServerIP();
                vscode.window.showErrorMessage("Upload Failed: " + e.message, "Retry")
                    .then(res => { res == "Retry" && uploadDocs(sfilter) });
            });
    });
    readConf();
}

async function setVersion() {
    const version = await vscode.window.showQuickPick(conf.vers, { title: "Pick Filter Type" });
    if (!version) return;
    await generate({ set: "v", value: version, gen: false });
    readConf();
}

async function chooseFilter() {
    const items = ["Language: " + filter.lang, "Version: " + filter.ver, "Scope: " + filter.scope, "Name: " + filter.name, "Clear"];
    /** @type {typeof items[number] | undefined} */
    const selection = await vscode.window.showQuickPick(items, { title: "Pick Filter Type" });
    const type = selection?.split(":")[0];

    if (type == "Language") selectFilter(conf.langs, "Pick Language", filter.lang).then(s => s && (filter.lang = s));
    else if (type == "Version") selectFilter(conf.vers, "Pick Version", filter.ver).then(s => s && (filter.ver = s));
    else if (type == "Scope") selectFilter(conf.scopes, "Pick Scope", filter.scope).then(s => s && (filter.scope = s));
    else if (type == "Name") enterNameFilter();
    else if (type == "Clear") filter.lang = filter.ver = filter.scope = filter.name = "*";
    else if (type) await vscode.window.showWarningMessage("This is not okay, youre warned!");
}

/** @type {(list:string[]|Obj<string>, title:string, dflt?:string) => Promise<string | undefined>} */
async function selectFilter(list, title, dflt = "*") {
    const items = Object.values(list);
    if (!Array.isArray(list)) Object.keys(list).forEach((k, i) => items[i] = `${k} (${items[i]})`)
    items.push("* (all)");

    let placeHolder = items.find(s => s.includes(dflt)) || "all (*)";
    const res = await vscode.window.showQuickPick(items, { title, placeHolder });
    setTimeout(updateTooltip, 100);
    return res && res.split(' ')[0];
}

async function selectCommand(all = false) {
    const items = !all ? commands : Object.keys(cmdMap).filter(c => !"selectCommand,allCommands".includes(c));
    const title = await vscode.window.showQuickPick(items.map(c => cmdMap[c]), {
        title: "Select Command", placeHolder: "Generate"
    });
    const cmd = pkg.contributes.commands.find(c => c.title == titlePrefix + title);
    if (!cmd) return;
    await vscode.commands.executeCommand(cmd.command);
}

async function enterNameFilter() {
    const pattern = await vscode.window.showInputBox({
        title: "Enter Pattern", placeHolder: "Create*"
    });
    if (!pattern) return;

    try {
        filter.name = /^\*?$/.test(pattern) ? pattern : RegExp(pattern).source;
        updateTooltip();
    }
    catch (e) {
        await vscode.window.showErrorMessage("Invalid RegExp Pattern: " + pattern);
    }
}

function langDir(l = filter.lang) { return l == "*" || l == "en" ? "docs" : "docs-" + l; }

/** @type {(lang:string, ver:string) => string} */
function getDocsPath(lang, ver) {
    const subPath = ["out"];
    const langs = Object.keys(conf.langs);
    subPath.push(langDir(lang == "*" ? langs[0] : lang));
    subPath.push(ver == "*" ? conf.vers[0] : ver);
    return path.join(folderPath, ...subPath);
}

/** @type {(lang:string, ver:string, scope:string, name:string) => string} */
function getServerPath(lang, ver, scope, name) {
    const docsPath = getDocsPath(lang, ver);
    const subPath = [docsPath];

    if (name == "*")
        subPath.push(scope == "*" ? "Docs.htm" : conf.scopes[scope].replace(/\s+/g, "") + ".htm");
    else {
        const globPath = path.join(folderPath, ...subPath, scope, '*' + name.replace(/\.\*/g, "*").replace(/\s+/g, '') + '*');
        const files = glob.sync(globPath, { windowsPathsNoEscape: true, nodir: true, });
        const scopeName = path.basename(path.dirname(files[0] || "*"));
        if (files.length == 1) subPath.push(scopeName, path.basename(files[0]))
        else subPath.push("Docs.htm");
    }
    return path.join(...subPath);
}

async function openWithLiveServer(sfilter = filter) {
    const docsPath = getServerPath(sfilter.lang, sfilter.ver, sfilter.scope, sfilter.name);
    if (!fs.existsSync(docsPath)) return;
    const fileUri = vscode.Uri.file(docsPath);
    await vscode.commands.executeCommand('livePreview.start.preview.atFile', fileUri);
}

/** @param {vscode.Uri} uri */
async function generateFile(uri) {
    const fileFilter = util.getFileFilter(uri);
    if (fileFilter) generate({ filter: fileFilter });
}

/** @type {vscode.CompletionItemProvider["provideCompletionItems"]} */
function provideCompletionItems(doc, pos, token, context) {
    const ln = pos.line;
    const cd = doc.lineAt(ln).text;
    const area = cd.slice(Math.max(pos.character - 12, 0), pos.character);

    if (!cd.includes("@param") && !cd.includes("@return") && !area.match(/\w+(:|\|\|)\w*/)) return;

    const completionItems = Object.keys(tnames).map(a => {
        const item = new vscode.CompletionItem(a, vscode.CompletionItemKind.Property);
        let b = a.split(/\\?_/)[0];
        item.detail = b ? tnames[b] + ": " + tnames[a] : tnames[a];
        return item;
    });

    return completionItems;
}

module.exports = {
    activate,
    deactivate
}
