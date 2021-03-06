/* private */
var _options = require('./options');
var Mode = require('./mode');
var Command = require('./wrapper').Command;

var state; // current builder state
var stack; // result builder
var staticArraysHolder = {}; // holder for static arrays
var wrapper; // external wrapper functionality
var helpers; // keys for helpers
var localComponentNames = []; // keys for local helpers

var empty = '', quote = '"', comma = ', "', removable = '-%%&&##__II-'; // auxiliary

var nestingLevelInfo = {level: 0, skip: []};

function isRootNode() {
    return nestingLevelInfo.level === 0;
}

function makeKey() {
    var text = new Array(12), possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefgijklmnopqrstuvwxyz';
    for (var i = 0; i < 12; i++)
        text.push(possible.charAt(Math.floor(Math.random() * possible.length)));

    return text.join(empty);
}

function decodeAccessory(string, force) {
    var regex = new RegExp(_options.accessory.open + '|' + _options.accessory.close, 'g');
    var code;
    var isStatic = true, openStub, closeStub;

    if (string !== undefined)
        code = string.split(regex).map(function (piece, i) {
            openStub = '';
            closeStub = '';

            if (i % 2) {
                isStatic = false;
                piece = piece.trim();
                if (_options.emptyString && !force) { // undefined as empty string
                    if (piece.indexOf(' ') !== -1) {
                        openStub = '(';
                        closeStub = ')';
                    }
                    return ' + (' + openStub + piece + closeStub + ' === undefined ? "" : '
                        + openStub + piece + closeStub + ') + ';
                } else
                    return ' + ' + piece + ' + ';
            } else {
                return JSON.stringify(piece);
            }
        }).join('');
    else
        code = '""';

    // micro-optimizations (remove appending empty strings)
    code = code.replace(/^"" \+ | \+ ""$/g, '').replace(/ \+ "" \+ /g, ' + ');

    return {value: code, isStatic: isStatic};
}

function formatText(text) {
    return text.trim()
        .replace(/&#(\d+);/g, function (match, dec) {
            return String.fromCharCode(dec);
        })
        .replace(_options.escape, function (m) {
            return _options.MAP[m];
        });
}

function prepareKey(command, attributes, useKeyCommand) {
    var result = empty, decode, stub;
    if ((command === Command.elementOpen || command === Command.elementVoid)) {

        if (attributes && attributes.hasOwnProperty(_options.staticKey)) {
            decode = decodeAccessory(attributes[_options.staticKey] || makeKey());
            delete attributes[_options.staticKey];
        } else if (useKeyCommand) {
            decode = {value: Command.getKey};
        } else {
            decode = {value: 'null'};
        }
        stub = (Object.keys(attributes).length > 0) ? ', ' : empty;
        result = ', ' + decode.value + stub;
    }
    return result;
}

function prepareAttr(command, attributes) {
    var result = empty, attr, decode, arrayStaticKey = false, isSkipped = false, skipCommand;
    if ((command === Command.elementOpen || command === Command.elementVoid) && Object.keys(attributes).length > 0) {
        if (attributes && attributes.hasOwnProperty(_options.staticArray)) {
            arrayStaticKey = attributes[_options.staticArray] || makeKey();
            staticArraysHolder[arrayStaticKey] = staticArraysHolder[arrayStaticKey] || {};
            delete attributes[_options.staticArray];
        }

        if (attributes && attributes.hasOwnProperty(_options.skipAttr)) {
            isSkipped = true;
            skipCommand = Command.startSkipContent(decodeAccessory(attributes[_options.skipAttr], true).value);
            delete attributes[_options.skipAttr];
        }

        result = arrayStaticKey || null;
        for (var key in attributes) {
            attr = attributes[key];
            attr = (attr === null) ? key : ((attr === undefined) ? '' : attr);
            decode = decodeAccessory(attr);
            if (decode.isStatic && (_options.nonStaticAttributes.indexOf(key) === -1)) {
                if (arrayStaticKey) {
                    var value = formatText(attr);
                    if (!staticArraysHolder[arrayStaticKey].hasOwnProperty(key)) {
                        staticArraysHolder[arrayStaticKey][key] = value;
                    } else if (staticArraysHolder[arrayStaticKey][key] !== value) {
                        staticArraysHolder[arrayStaticKey][key] = removable;
                        result += comma + key + '", "' + value + quote;
                    }
                } else
                    result += comma + key + '", "' + formatText(attr) + quote;
            } else {
                result += comma + key + '", ' + formatText(decode.value);
            }
        }
    }
    return {value: result, isSkipped: isSkipped, skip: skipCommand};
}

function unwrapStaticArrays(holder) {
    var result = {}, obj, key;
    for (var arrayName in holder) {
        obj = holder[arrayName];
        result[arrayName] = [];

        for (key in obj)
            if (obj[key] !== removable)
                result[arrayName].push(quote + key + quote, quote + obj[key] + quote);
    }

    return result;
}

function decodeAttrs(obj) {
    var result = ['{'];
    for (var key in obj)
        result.push(((result.length > 1) ? ',' : empty) + '\'' + key + '\'' + ':' + decodeAccessory(obj[key], true).value);
    result.push('}');

    return result.join(empty);
}

function camelCase(input) {
    return input.replace(/\s/g, '').replace(/-(.)/g, function (match, group1) {
        return group1.toUpperCase();
    });
}

function writeCommand(command, tag, attributes) {
    if (attributes && attributes.ref) {
        var refName = attributes.ref;
        delete attributes.ref;
    }

    var strKey = prepareKey(command, attributes);
    var strAttrs = prepareAttr(command, attributes);

    if (refName) {
        // i.e. ref[refName] = elementOpen(...)
        command = Command.saveRef(camelCase(decodeAccessory(refName, true).value), command);
    }

    stack.push(command + tag + quote + strKey + strAttrs.value + Command.close);

    // save skipped
    if (strAttrs.isSkipped) {
        stack.push(strAttrs.skip);
        nestingLevelInfo.skip.push(nestingLevelInfo.level);
    }
}

function writeText(text) {
    text = formatText(text);
    if (text.length > 0) {
        var decode = decodeAccessory(text);
        stack.push(Command.text + decode.value + Command.close);
    }
}

function helperOpen(helperName, attrs) {
    stack.push(Command.helpers + '["' + helperName + '"](' + decodeAttrs(attrs) + ', function (' 
        + _options.parentParameterName + '){');
}

function helperClose() {
    stack.push('}.bind(this));');
}

function isHelperTag(tagName) {
    return localComponentNames.indexOf(tagName) !== -1 
        || helpers.indexOf(tagName) !== -1
        || tagName.indexOf(_options.helperPre) === 0;
}

function binderOpen(helperName, attrs) {
    var fnName = helperName.replace(_options.binderPre, '');
    stack.push(Command.binder + '(' + fnName + ',' + decodeAttrs(attrs) + ', function (' 
        + _options.parentParameterName + '){');
}

function binderClose() {
    stack.push('}.bind(this));');
}

function isTagBinded(tagName) {
    return tagName.indexOf(_options.binderPre) === 0;
}

// TODO: Clarify logic.
// Seems like this method only opens state but named as 'CloseOpenState'
// also seems like `isClosed` flags used only to detect elementVoid and it's a bit confusing
// because sounds like it can be used to detect tags open or close state.
function writeAndCloseOpenState(isClosed) {
    var isShouldClose = true;

    if (state.tag) {
        var isRoot = isRootNode();

        if (isHelperTag(state.tag)) { // helper case
            helperOpen(state.tag, state.attributes);
            isShouldClose = isClosed;
        } else if (isTagBinded(state.tag)) {
            binderOpen(state.tag, state.attributes);
            isShouldClose = isClosed;
        } else if (isClosed || _options.voidRequireTags.indexOf(state.tag) !== -1) { // void mode
            writeCommand(Command.elementVoid, state.tag, state.attributes, isRoot);
            nestingLevelInfo.level--;
            isShouldClose = false;
        } else if (state.tag !== _options.evaluate.name) { // standard mode
            writeCommand(Command.elementOpen, state.tag, state.attributes, isRoot);
        } // if we write code, do nothing

        nestingLevelInfo.level++;
    }

    // clear builder state for next tag
    state.tag = null;
    state.attributes = {};

    return isShouldClose; // should we close this tag: no if we have void element
}

/* public */
function Builder(functionWrapper) {
    wrapper = functionWrapper;
    this.reset();
}

Builder.prototype.reset = function () {
    stack = [];
    state = {
        tag: null,
        attributes: {}
    };
    staticArraysHolder = {};
    nestingLevelInfo = {level: 0, skip: []};
};

Builder.prototype.set = function (helpersKeys, localNames) {
    helpers = helpersKeys;
    localComponentNames = localNames || [];
};

Builder.prototype.write = function (command) {
    var tag;
    switch (command.type) {
        case Mode.Tag:
            tag = command.name.replace('/', empty);

            if (command.name.indexOf('/') === 0) {

                // close tag case
                if (writeAndCloseOpenState(true) && tag !== _options.evaluate.name) {
                    nestingLevelInfo.level--;

                    // write end skip functionality
                    if (nestingLevelInfo.level === nestingLevelInfo.skip[nestingLevelInfo.skip.length - 1]) {
                        stack.push(Command.endSkipContent);
                        nestingLevelInfo.skip.pop();
                    }

                    if (isHelperTag(tag))
                        helperClose();
                    else if (isTagBinded(tag))
                        binderClose();
                    else
                        writeCommand(Command.elementClose, tag);
                }
            } else {
                // open tag case
                writeAndCloseOpenState();
                state.tag = tag;
                state.attributes = {};
            }
            break;
        case Mode.Attr: // push attribute in state
            state.attributes[command.name] = command.data;
            break;
        case Mode.Text: // write text
            tag = state.tag;
            writeAndCloseOpenState();
            if (tag === _options.evaluate.name) { // write code
                stack.push(formatText(command.data));
            } else {
                writeText(command.data);
            }
            break;
        case Mode.Comment: // write comments only in debug mode
            if (_options.debug)
                stack.push('\n// ' + command.data.replace(_options.BREAK_LINE, ' ') + '\n');
            break;
    }
};

Builder.prototype.done = function () {
    return wrapper(stack, unwrapStaticArrays(staticArraysHolder));
};

module.exports = Builder;