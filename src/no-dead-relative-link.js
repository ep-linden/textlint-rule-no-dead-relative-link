import "@babel/polyfill";
import fs from 'fs';
import path from 'path';
import url from 'url';
import {parse, Syntax} from '@textlint/markdown-to-ast';
import {traverse, VisitorOption} from '@textlint/ast-traverse';
import GithubSlugger from 'github-slugger';
import util from 'util';
import { wrapReportHandler} from 'textlint-rule-helper';

const fileRead = util.promisify(fs.readFile);

//https://stackoverflow.com/a/31991870
const externalLinkRegex = new RegExp(/^[a-z][a-z0-9+.-]*:/, 'i');

export default function(context, options) {
    return wrapReportHandler(context, {
        ignoreNodeTypes: [Syntax.code]
    }, () => handler(context, options));
}

function handler(context, options) {
    return {
        [context.Syntax.Link] (linkNode) {
            return validateLinkNode(linkNode, context, options);
        }
    }
}

async function validateLinkNode(linkNode, context, options) {
    if (!linkNode.url || externalLinkRegex.test(linkNode.url)) {
        return;
    } else if (linkNode.url[0] === '#') {
        return validateAnchorLink(context.getFilePath(), linkNode.url.slice(1), linkNode, context);
    } else {
        return validateRelativeLink(linkNode, context, options);
    }
}

async function validateRelativeLink(linkNode, context, options) {
    let linkAbsolutePath = path.resolve(path.dirname(context.getFilePath()), linkNode.url);
    let linkURL = new URL("file://" + linkAbsolutePath);
    let linkedFileExtension = path.extname(linkURL.pathname);

    if (linkedFileExtension !== ".md" && options["resolve-as-markdown"] && options["resolve-as-markdown"].includes(linkedFileExtension)) {
        linkURL.pathname = linkURL.pathname.replace(linkedFileExtension, ".md");
    }
    if (!await fileExists(url.fileURLToPath(linkURL))) {
        let mappingExists = false;
        if (options["route-map"]) {
            mappingExists = await routedLinkExists(context, options, linkNode);
        }
        if (!mappingExists) {
            reportError(linkNode, context, `${path.basename(linkURL.pathname)} does not exist`);
        }
        return;
    }
    if(linkURL.hash && path.extname(linkURL.pathname) === ".md") {
        return validateAnchorLink(url.fileURLToPath(linkURL), linkURL.hash.slice(1), linkNode, context);
    }
}

async function routedLinkExists(context, options, linkNode) {
    let linkRouteMaps = options["route-map"];
    let nodeUrl = linkNode.url;
    //Regex to check find forward slashes (\) that escapes capture groups
    let captureGroupRegex = new RegExp("(?<=\\.*)\\\\(?=\\d+)", "g");

    for (const mapping of linkRouteMaps) {
        let sourceRegex = new RegExp(mapping["source"], "g");
        let mappedDestination = mapping["destination"].replace(captureGroupRegex, "$");
        if (sourceRegex.test(nodeUrl)) {
            let routedUrl = nodeUrl.replace(sourceRegex, mappedDestination);
            let linkAbsolutePath = path.resolve(path.dirname(context.getFilePath()), routedUrl);
            let linkURL = new URL("file://" + linkAbsolutePath);
            if (await fileExists(url.fileURLToPath(linkURL))) {
                return true;
            }
        }
    }
    return false;
}

async function fileExists(url) {
    let access = util.promisify(fs.access);
    try {
        await access(url);
        return true;
    } catch (e) {
        return false;
    }
}

async function validateAnchorLink(filePath, anchor, linkNode, context) {
    let fileContent = await fileRead(filePath, 'utf8');
    let ast = parse(fileContent);
    let slugger = new GithubSlugger();
    let found = false;
    traverse(ast, {
        enter(node) {
            if (node.type === Syntax.Header) {
                let headerStr = node.raw.substring(node.depth).trim();
                let id = slugger.slug(headerStr);
                if (id === anchor) {
                    found = true;
                    return VisitorOption.Break;
                }
            }
        }
    });
    if (!found) {
        reportError(linkNode, context, `Anchor #${anchor} does not exist in ${path.basename(filePath)}`);
    }
}

function reportError(linkNode, context, errorMessage) {
    context.report(linkNode, new context.RuleError(errorMessage, {
        index: linkNode.raw.indexOf(linkNode.url) || 0
    }));
}