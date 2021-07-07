'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const types = require('@babel/types');

const utils = {
    /**
     * 获取 Literal 类型的节点
     * @param {Object} obj
     * @returns {NumericLiteral|StringLiteral|BooleanLiteral|null}
     */
    getLiteralNode(obj) {
        let typeName = typeof obj;
        switch (typeName) {
            case 'number':
                return types.numericLiteral(obj);
            case 'string':
                return types.stringLiteral(obj);
            case 'boolean':
                return types.booleanLiteral(obj);
            default:
                return null;
        }
    },
    /**
     * 获取 Literal 值
     * @param {StringLiteral|Identifier} node
     * @returns {string}
     */
    getStringLiteralValue(node) {
        let value;
        switch (node.type) {
            case 'StringLiteral':
                value = node.value;
                break
            case 'Identifier':
                value = node.name;
                break
            default:
                throw new Error(`Not supported node: ${node.type}`);
        }

        return value;
    },
    /**
     * 寻找属性(自动判断 key 类型)
     * @param {ObjectProperty[]} properties
     * @param {string} name
     * @returns {ObjectProperty|null}
     */
    findProperty(properties, name) {
        for (let property of properties) {
            let propertyName;
            switch (property.key.type) {
                case 'StringLiteral':
                    propertyName = property.key.value;
                    break
                case 'Identifier':
                    propertyName = property.key.name;
                    break
                default:
                    continue
            }

            if (propertyName === name) {
                return property;
            }
        }

        return null;
    },
    /**
     * 转换到参1数组指定成员
     * @param {Identifier[]} arguments_
     * @param {string} argumentName
     * @returns {number}
     */
    indexOfArgument(arguments_, argumentName) {
        for (let i = 0; i < arguments_.length; i++) {
            if (arguments_[i].name === argumentName) {
                return i;
            }
        }

        return -1;
    },
    /**
     * 是否有效的变量名
     * @param {string} name
     * @returns {boolean}
     */
    isValidVariableName(name) {
        return /^[A-Za-z_$][\w$]*$/.test(name);
    },
    /**
     * 是否hex变量名 _0x123
     * @param {string} name
     * @returns {boolean}
     */
    isHexVariableName(name) {
        return /^_0x[a-f0-9]+$/i.test(name);
    },
    /**
     * 转换为实例化的名字 e.g. Image -> image
     * @param {string} name
     * @returns {string}
     */
    getInstantiatedName(name) {
        if (!/^[A-Z]/.test(name)) {
            return name;
        }

        let firstStr = name.substr(0, 1).toLowerCase();
        let secondStr = name.substr(1);
        return firstStr + secondStr;
    }
};

/**
 * 优化代码
 * @param {string} jsCode
 * @returns {string}
 * @returns {string}
 */
function optimize(jsCode) {
    let parseOptions = {};
    let ast = parser.parse(jsCode, parseOptions);
    let cache = {
        /**
         * key=string
         * value=NodePath
         */
        corePaths: {},

        /**
         * NodePath
         */
        coreRefPaths: [],

        /**
         * key=string
         * value=NodePath
         */
        proxyPaths: {},

        /**
         * key=string
         * value=prevKeyLength, path, properties, originPaths
         */
        doubtedProxyPathInfos: {},

        /**
         * 从 proxyPath | doubtedProxyPathInfo 依次取出
         * @param {string} name
         * @returns {NodePath|null}
         */
        getValidProxyPath(name) {
            return cache.proxyPaths[name] || (cache.doubtedProxyPathInfos[name] && cache.doubtedProxyPathInfos[name].path);
        },

        /**
         *
         * @param name
         * @param propertyName
         * @returns {Node|null}
         */
        getValidProxyPathProperty(name, propertyName) {
            if (name in cache.proxyPaths) {
                return utils.findProperty(cache.proxyPaths[name].node.properties, propertyName)
            }

            if (name in cache.doubtedProxyPathInfos) {
                return utils.findProperty(cache.doubtedProxyPathInfos[name].properties, propertyName)
            }

            return null;
        }
    };

    // 加密函数可能后置到底部, 所以单独拎出来
    let visitorDetectEncrypt = {
        SequenceExpression(path) {
            // (a(),b()) -> a(); b();
            if (path.parentPath.node.type !== 'ExpressionStatement') {
                return;
            }

            let newNodes = [];
            for (let expression of path.node.expressions) {
                newNodes.push(types.expressionStatement(expression));
            }

            path.replaceInline(newNodes);
        },
        StringLiteral(path) {
            // 捕获 加密函数特征2
            if (path.node.value === 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/='
                || path.node.value === 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') {
                //
                let destPath = path.find(itemPath => itemPath.node
                    && (itemPath.node.type === 'FunctionDeclaration'
                        && itemPath.node.params.length === 2)
                    || (itemPath.node.type === 'VariableDeclaration'
                        && itemPath.node.declarations.length === 1
                        && itemPath.node.declarations[0].init.type === 'FunctionExpression'
                        && itemPath.node.declarations[0].init.params.length === 2));

                if (destPath) {
                    context.addEncryptFunction(destPath);
                }
            }
        },
        VariableDeclaration(path) {
            // var a,b; -> var a; var b;
            if (path.node.declarations.length > 1) {
                let kind = path.node.kind;
                let newNodes = path.node.declarations.map(value => types.variableDeclaration(kind, [value]));
                path.replaceInline(newNodes);
            }
        },
        enter(path) {
            // 捕获 加密函数特征1
            if (context.isEncryptFunction(path)) {
                context.addEncryptFunction(path);
            }
        }
    };
    let visitor = {
        AssignmentExpression: {
            exit(path) {
                // #空对象声明后续赋值
                // 判断赋值
                // e.g. proxyObj['add']=function(a,b){return a+b};
                if (path.node.left.type === 'MemberExpression'
                    && (path.node.left.property.type === 'StringLiteral'
                        || path.node.left.property.type === 'Identifier')
                    && (path.node.left.object.type === 'StringLiteral'
                        || path.node.left.object.type === 'Identifier')) {
                    //
                    let objectName = utils.getStringLiteralValue(path.node.left.object);
                    if (objectName in cache.doubtedProxyPathInfos) {
                        let cacheObj = cache.doubtedProxyPathInfos[objectName];
                        let propertyName = utils.getStringLiteralValue(path.node.left.property);
                        let propertyNameLength = propertyName.length;
                        if (!cacheObj.prevKeyLength) {
                            cacheObj.prevKeyLength = propertyNameLength;
                        }

                        if (propertyNameLength !== 5 || propertyNameLength !== cacheObj.prevKeyLength) {
                            delete cache.doubtedProxyPathInfos[objectName];
                        } else {
                            // 转换为ObjectProperty
                            if (utils.findProperty(cacheObj.properties, propertyName) === null) {
                                let newNode = types.objectProperty(types.stringLiteral(propertyName), path.node.right, true);
                                cacheObj.properties.push(newNode);
                                cacheObj.originPaths.push(path);
                            }
                        }
                    }
                }
            }
        },
        BinaryExpression: {
            exit(path) {
                let node = path.node;
                switch (node.operator) {
                    case '+':
                    case '-':
                    case '*':
                    case '/':
                    case '===':
                    case '!==':
                        // 相同类型的相加减乘除:
                        // - 'hello' + ' world '+ 2021 + true -> 'hello world 2021true'
                        // - 123 + 456 -> 579
                        // - -1059744 + 5959 * -94 + 21176 * 107 -> 645942
                        // - "str" === "stfrr" -> true
                        // - "str" !== "str" -> false
                        if (node.left.type.endsWith('Literal')
                            && node.left.type === node.right.type) {
                            //
                            let code = generate(node).code;
                            let retVal = global.eval(code);

                            path.replaceInline(utils.getLiteralNode(retVal));
                        } else {
                            let code;
                            if ((node.left.type === 'UnaryExpression'
                                && node.left.operator === '-'
                                && node.left.argument.type === 'NumericLiteral')
                                || node.left.type === 'NumericLiteral') {
                                //
                                code = generate(node.left).code;
                                if ((node.right.type === 'UnaryExpression'
                                    && node.right.operator === '-'
                                    && node.right.argument.type === 'NumericLiteral')
                                    || node.right.type === 'NumericLiteral') {
                                    //
                                    code = `${code} ${node.operator} ${generate(node.right).code}`;
                                    let retVal = global.eval(code);
                                    path.replaceInline(utils.getLiteralNode(retVal));
                                }
                            }
                        }
                        break
                    default:
                        break;
                }
            }
        },
        CallExpression: {
            exit(path) {
                // e.g. eval()
                let node = path.node;
                if (node.callee.type === 'Identifier'
                    && node.callee.name === 'eval') {
                    //
                    let gr = generate(node);
                    let currentJsCode = gr.code.replace(/eval/, '');
                    path.replaceInline(currentJsCode);
                    return;
                }

                // - proxyObj['add'](1,2) | proxyObj.add(1,2) -> 3
                // - proxyObj['add'](arg,2) -> arg + 2
                // - proxyObj['typeof'](arg,'string') -> typeof arg === 'string'
                // - proxyObj.dec(arg,2) -> arg - 2
                node = path.node;
                if (node.callee.type === 'MemberExpression'
                    && node.callee.object.type === 'Identifier'
                    && (node.callee.property.type === 'StringLiteral'
                        || node.callee.property.type === 'Identifier')) {
                    //
                    if (cache.getValidProxyPath(node.callee.object.name)) {
                        let propertyName = utils.getStringLiteralValue(node.callee.property);
                        let proxyProperty = cache.getValidProxyPathProperty(node.callee.object.name, propertyName);
                        if (proxyProperty) {
                            let newNode = context.getReplacedCallObjectPropertyNode(proxyProperty, node.arguments);
                            if (newNode) {
                                path.replaceInline(newNode);
                            }
                        }
                    }
                }

                // 解密加密函数; 排除代理解密函数特征
                // e.g. core(1,2)
                node = path.node;
                if (node.callee.type === 'Identifier'
                    && node.callee.name in cache.corePaths
                    && node.callee.name in global
                    && !(path.parentPath.node.type === 'ReturnStatement'
                        && path.parentPath.parentPath.node.type === 'BlockStatement'
                        && path.parentPath.parentPath.node.body.length === 1)) {
                    //
                    let gr = generate(node);
                    try {
                        let retVal = global.eval(gr.code);
                        let literalNode = utils.getLiteralNode(retVal);
                        if (literalNode) {
                            path.replaceInline(literalNode);
                        }
                    } catch (e) {
                        console.warn(`Decode function error: ${e} ${gr.code}`);
                    }
                }

                // - function(a,b){return a(b)}(navigator,'userAgent') -> navigator['userAgent'] 注意: 这是自身替换后生成的错误语法
                node = path.node;
                if (node.callee
                    && node.callee.type === 'FunctionExpression'
                    && node.callee.body.type === 'BlockStatement'
                    && node.callee.body.body.length === 1
                    && node.callee.body.body[0].type === 'ReturnStatement') {
                    //
                    let newNode = context.getFunctionExpressionCallNode(node.callee, node.arguments);
                    if (newNode) {
                        path.replaceInline(newNode);
                    }
                }
            }
        },
        ConditionalExpression: {
            exit(path) {
                // 移除死代码
                // e.g. true?console.log('Action...'):console.log('No action');
                let node = path.node;
                if (node.test.type === 'BooleanLiteral') {
                    let newNode = node.test.value ? node.consequent : node.alternate;
                    path.parentPath.replaceWith(newNode);
                }
            }
        },
        FunctionDeclaration: {
            exit(path) {
                // 代理解密函数
                // e.g. function proxyCore(a,b,c,d,e){return core(a-123,b);}
                let node = path.node;
                let destNode;
                if (node.body.type === 'BlockStatement'
                    && node.body.body.length === 1
                    && (destNode = node.body.body[0])
                    && destNode.type === 'ReturnStatement'
                    && destNode.argument.type === 'CallExpression'
                    && destNode.argument.callee
                    && destNode.argument.callee.name in global) {
                    //
                    let gr = generate(node);
                    global.eval(gr.code);
                    cache.corePaths[node.id.name] = path;
                    path.skip();
                }
            }
        },
        FunctionExpression: {
            exit(path) {
                // 代理解密函数
                // e.g. let proxyCore=function(a,b,c,d,e){return core(a-123,b);}
                let node = path.node;
                let destNode;
                if (path.parentPath.type === 'VariableDeclarator'
                    && node.body.type === 'BlockStatement'
                    && node.body.body.length === 1
                    && (destNode = node.body.body[0])
                    && destNode.type === 'ReturnStatement'
                    && destNode.argument.type === 'CallExpression'
                    && destNode.argument.callee
                    && destNode.argument.callee.name in global) {
                    //
                    let gr = generate(path.parentPath.node);
                    global.eval(gr.code);
                    cache.corePaths[path.parentPath.node.id.name] = path;
                    path.skip();
                }
            }
        },
        IfStatement: {
            exit(path) {
                // 移除死代码
                // if(false){
                //  // 这里永远不会执行
                // }
                let node = path.node;
                if (node.test.type === 'BooleanLiteral') {
                    let newNode = node.test.value === true ? node.consequent : node.alternate;
                    if (newNode) {
                        // else if(xxx)
                        if (newNode.type === 'IfStatement') {
                            path.replaceInline(newNode);
                        } else {
                            // 带花括号的语句(body属性)和不带花括号的
                            path.replaceInline(newNode.body ? newNode.body : newNode);
                        }
                    } else {
                        path.remove();
                    }
                }
            }
        },
        MemberExpression: {
            exit(path) {
                // 代理对象的属性读取(但不是赋值, 被赋值)
                // - proxyObj.abcde -> 123
                // - proxyObj['12345'] -> 456
                // - this.name = proxyObj.abcde -> this.name = 123
                if (!(path.parentPath.node.type === 'AssignmentExpression'
                    && path.parentPath.node.left === path.node)
                    && path.node.object.type === 'Identifier'
                    && (path.node.property.type === 'Identifier'
                        || path.node.property.type === 'StringLiteral')
                    && utils.isValidVariableName(path.node.object.name)) {
                    //
                    if (cache.getValidProxyPath(path.node.object.name)) {
                        let propertyName = utils.getStringLiteralValue(path.node.property);
                        let proxyProperty = cache.getValidProxyPathProperty(path.node.object.name, propertyName);
                        if (proxyProperty) {
                            let newNode = proxyProperty.value;
                            if (newNode) {
                                path.replaceInline(newNode);
                            }
                        }
                    }
                }
            }
        },
        NumericLiteral: {
            exit(path) {
                // 0x123 -> 291
                // NOTE: 代码生成的不存在属性 extra
                let node = path.node;
                if (node.extra) {
                    node.extra.raw = node.value.toString();
                }
            }
        },
        ObjectExpression: {
            exit(path) {
                // 捕获 代理对象特征
                if (path.parentPath.type === 'VariableDeclarator') {
                    let prevKeyLength = 0;
                    let conformed = true;

                    // #空对象声明后续赋值
                    // 标记
                    if (path.node.properties.length === 0) {
                        // 公用cache对象, 要先判断是否已经添加
                        if (!(path.parentPath.node.id.name in cache.doubtedProxyPathInfos)) {
                            cache.doubtedProxyPathInfos[path.parentPath.node.id.name] = {
                                prevKeyLength: 0,
                                path: path,
                                properties: [],
                                originPaths: []
                            };
                        }
                    } else {
                        for (let property of path.node.properties) {
                            if (!(property.key.type === 'Identifier' || property.key.type === 'StringLiteral')) {
                                conformed = false;
                                break
                            }

                            let keyLength = utils.getStringLiteralValue(property.key).length;
                            if (prevKeyLength === 0) {
                                prevKeyLength = keyLength;
                                continue;
                            }

                            if (keyLength !== 5 || keyLength !== prevKeyLength) {
                                conformed = false;
                                break;
                            }
                        }

                        if (conformed) {
                            cache.proxyPaths[path.parentPath.node.id.name] = path;
                        }
                    }
                }
            }
        },
        ObjectProperty: {
            exit(path) {
                // e.g. {'name':'nameValue'} -> {name:'nameValue'}
                if (path.node.key.type === 'StringLiteral'
                    && utils.isValidVariableName(path.node.key.value)) {
                    path.node.key = types.identifier(path.node.key.value)
                }
            }
        },
        StringLiteral: {
            exit(path) {
                // NOTE:
                // - window['console'] -> window.console
                // - '1,2,3'['split']
                // - this['name']
                // - proxyCall()['add']
                // - new Date()['getTime']
                // - []['split']
                // - {}['split']
                // - (function(){})['call']
                // - (''+2/1)['length']
                if (path.parentPath.node.type === 'MemberExpression'
                    && (path.parentPath.node.object.type === 'MemberExpression'
                        || path.parentPath.node.object.type === 'Identifier'
                        || path.parentPath.node.object.type === 'StringLiteral'
                        || path.parentPath.node.object.type === 'ThisExpression'
                        || path.parentPath.node.object.type === 'CallExpression'
                        || path.parentPath.node.object.type === 'NewExpression'
                        || path.parentPath.node.object.type === 'ArrayExpression'
                        || path.parentPath.node.object.type === 'ObjectExpression'
                        || path.parentPath.node.object.type === 'FunctionExpression'
                        || path.parentPath.node.object.type === 'BinaryExpression')
                    && utils.isValidVariableName(path.node.value)) {
                    //
                    path.parentPath.node.computed = false;
                    path.replaceInline(types.identifier(path.node.value));
                }
            }
        },
        SwitchStatement: {
            exit(path) {
                // switch 流程分化
                // let array = "1|0".split('|');
                // let index = 0;
                // while(true){
                //     switch(array[index++]){
                //         case '0':
                //             break;
                //         case '1':
                //             break;
                //     }
                //     break;
                // }
                if (path.parentPath.node.type === 'BlockStatement'
                    && path.parentPath.parentPath.node
                    && path.parentPath.parentPath.node.type === 'WhileStatement'
                    && path.parentPath.node.body.length === 2
                    && path.parentPath.node.body[1].type === 'BreakStatement'
                    && path.node.discriminant.object.type === 'Identifier'
                    && path.node.discriminant.property.type === 'UpdateExpression'
                    && path.node.discriminant.property.operator === '++'
                    && path.node.discriminant.property.argument.type === 'Identifier') {
                    //
                    let id = path.node.discriminant.object;
                    let idInt = path.node.discriminant.property.argument;
                    let bindingStr = path.scope.getBinding(id.name);
                    let bindingInt = path.scope.getBinding(idInt.name);
                    let pad;
                    let padOperator;
                    bindingStr && bindingStr.path.traverse({
                        StringLiteral(path) {
                            if (path.parentPath.node.type === 'MemberExpression') {
                                pad = path.node.value;
                            } else if (path.parentPath.node.type === 'CallExpression') {
                                padOperator = path.node.value;
                            }
                        }
                    });
                    if (pad && padOperator) {
                        let steps = pad.split(padOperator);
                        let newNodes = [];
                        let cases = path.node.cases;

                        for (let i = 0; i < steps.length; i++) {
                            let step = steps[i];
                            let switchCase = cases.find(switchCase => switchCase.test.value === step);
                            if (switchCase) {
                                // 去除 continue
                                newNodes.push(...switchCase.consequent.filter(item => item.type !== 'ContinueStatement'));
                            }
                        }

                        // 移除 step 数组 和 后面的变量
                        bindingStr.path.remove();
                        bindingInt.path.remove();

                        path.parentPath.parentPath.replaceInline(newNodes);
                        path.parentPath.parentPath.skip();
                    }
                }
            }
        },
        UnaryExpression: {
            exit(path) {
                if (path.node.operator === '!') {
                    // - !'' -> true
                    // - !0 -> true
                    // - !false -> true
                    // - ![] -> false 仅是空数组
                    // - !{} -> false 仅是空对象
                    // - !undefined
                    let booleanValue = null;
                    switch (path.node.argument.type) {
                        case 'NumericLiteral':
                            booleanValue = path.node.argument.value === 0;
                            break
                        case 'StringLiteral':
                            booleanValue = path.node.argument.value === '';
                            break
                        case 'BooleanLiteral':
                            booleanValue = path.node.argument.value === false;
                            break
                        case 'ArrayExpression':
                            if (path.node.argument.elements.length === 0) {
                                booleanValue = false;
                            }

                            break
                        case 'ObjectExpression':
                            if (path.node.argument.properties.length === 0) {
                                booleanValue = false;
                            }

                            break
                        case 'Identifier':
                            if (path.node.argument.name === 'undefined') {
                                booleanValue = true;
                            }
                            break
                        default:
                            break;
                    }

                    if (booleanValue != null) {
                        // 这里请不要 traverse 了
                        path.replaceInline(types.booleanLiteral(booleanValue));
                    }
                } else if (path.node.operator === '+') {
                    // e.g. +123 -> 123
                    switch (path.node.argument.type) {
                        case 'NumericLiteral':
                            path.replaceInline(path.node.argument);
                            break
                        default:
                            break
                    }
                }
            }
        },
        VariableDeclarator: {
            exit(path) {
                // 移除引用对象/加密函数(值类型则不可以)
                // e.g. let refObj=obj;
                if (path.node.id.type === 'Identifier'
                    && path.node.init
                    && path.node.init.type === 'Identifier'
                    && (path.node.init.name in cache.corePaths || cache.getValidProxyPath(path.node.init.name))) {
                    //
                    path.scope.rename(path.node.id.name, path.node.init.name);
                    path.remove();
                }
            }
        },
        enter(path) {
            // 移除未使用的变量
            if (path.node.type === 'VariableDeclarator') {
                let id = path.node.id;
                let binding = path.scope.getBinding(id.name);

                if (!binding || binding.constantViolations.length > 0) {
                    return;
                }

                if (binding.referencePaths.length === 0) {
                    path.remove();
                }
            }
        }
    };
    let visitorBeautify = {
        Identifier(path) {
            let id = path.node;
            // 更改变量名
            if (utils.isHexVariableName(id.name)) {
                //
                let sugVarName = null;
                if (path.parentPath.node.type === 'VariableDeclarator'
                    && path.parentPath.node.id === id) {
                    //
                    let init = path.parentPath.node.init;
                    if (init) {
                        switch (init.type) {
                            case 'ArrayExpression':
                                sugVarName = 'array';
                                break
                            case 'BooleanLiteral':
                                sugVarName = 'bool';
                                break
                            case 'CallExpression':
                                switch (init.callee.type) {
                                    case 'Identifier':
                                        sugVarName = utils.getInstantiatedName(init.callee.name);
                                        break
                                    case 'FunctionExpression':
                                        sugVarName = 'funcValue';
                                        break
                                }
                                break
                            case 'FunctionDeclaration':
                                sugVarName = init.id.name || 'func';
                                break
                            case 'FunctionExpression':
                                sugVarName = 'func';
                                break
                            case 'MemberExpression':
                                if (init.property.type === 'Identifier') {
                                    sugVarName = init.property.name;
                                } else if (init.property.type === 'StringLiteral') {
                                    sugVarName = init.property.value;
                                }
                                break
                            case 'NewExpression':
                                if (init.callee
                                    && init.callee.type === 'Identifier') {
                                    // 首字母小写
                                    sugVarName = init.callee.name;
                                    sugVarName = utils.getInstantiatedName(sugVarName);
                                }
                                break
                            case 'NumericLiteral':
                                sugVarName = 'num';
                                break
                            case 'ObjectExpression':
                                sugVarName = 'obj';
                                break
                            case 'StringLiteral':
                                sugVarName = 'str';
                                break
                            case 'ThisExpression':
                                sugVarName = 'self';
                                break
                            default:
                                break
                        }
                    }
                } else if (path.parentPath.node.type === 'CatchClause') {
                    sugVarName = 'error';
                } else if ((path.parentPath.node.type === 'FunctionDeclaration'
                    || path.parentPath.node.type === 'FunctionExpression')
                    && path.parentPath.node.id !== id) {
                    // 方法参数名
                    // e.g. _0x123 -> param1
                    sugVarName = 'param';
                }

                if (sugVarName) {
                    let newNode = path.scope.generateUidIdentifier(sugVarName);
                    path.scope.rename(id.name, newNode.name);
                }
            }

            // 变量命名:
            // var obj={
            // name: _var1
            // }
            // ->
            // var obj={
            // name: _name
            // }
            if (path.parentPath.node.type === 'ObjectProperty'
                && id === path.parentPath.node.key
                && !id.name.startsWith('_')
                && path.parentPath.node.value.type === 'Identifier'
                && path.parentPath.node.value.name.startsWith('_')) {
                //
                let uid = path.scope.generateUidIdentifier(id.name);
                path.scope.rename(path.parentPath.node.value.name, uid.name);
            }
        },
        MemberExpression(path) {
            // 如果发现代理对象存在name属性则该变量名
            // e.g. var proxyObj={name:'util',...} -> var util={name:'util'};
            if (path.parentPath.node.type === 'AssignmentExpression'
                && path.node.object
                && path.node.object.type === 'Identifier'
                && path.node.property.type === 'Identifier') {
                //
                let sugVarName = null;
                if (path.node.property.name === 'name'
                    && path.parentPath.node.right.type === 'StringLiteral') {
                    sugVarName = path.parentPath.node.right.value;
                } else if (path.node.property.name === 'define') {
                    sugVarName = 'lib';
                }

                if (sugVarName) {
                    let uid = path.scope.generateUidIdentifier(sugVarName);
                    path.scope.rename(path.node.object.name, uid.name);
                }
            }
        }
    };
    let context = {
        removePath(path) {
            // node可能为空(则直接返回)
            let outPath = path.find(itemPath => !itemPath.node
                || (itemPath.node.type === 'VariableDeclaration'
                    || itemPath.node.type === 'VariableDeclarator'
                    || itemPath.node.type === 'ExpressionStatement'
                    || itemPath.node.type === 'FunctionDeclaration'));
            if (outPath && !outPath.removed) {
                outPath.remove();
            }
        },
        cleanup() {
            for (let key in cache.corePaths) {
                context.removePath(cache.corePaths[key]);
            }

            for (let currentPath of cache.coreRefPaths) {
                context.removePath(currentPath);
            }

            for (let key in cache.proxyPaths) {
                context.removePath(cache.proxyPaths[key]);
            }

            for (let key in cache.doubtedProxyPathInfos) {
                let currentPathInfo = cache.doubtedProxyPathInfos[key];
                if (currentPathInfo.properties.length === 0) {
                    continue;
                }

                context.removePath(currentPathInfo.path);

                for (let currentPath of currentPathInfo.originPaths) {
                    context.removePath(currentPath);
                }
            }
        },
        /**
         * 发现是否加密函数
         * @param {NodePath} path FunctionDeclaration | FunctionExpression
         */
        isEncryptFunction(path) {
            let id;
            let params;
            let body;
            switch (path.node.type) {
                case 'FunctionDeclaration':
                    id = path.node.id;
                    params = path.node.params;
                    body = path.node.body;
                    break
                case 'FunctionExpression':
                    if (path.parentPath.node.type !== 'VariableDeclarator') {
                        return false;
                    }

                    id = path.parentPath.node.id;
                    params = path.node.params;
                    body = path.node.body;
                    break
                default:
                    return false;
            }

            if (params.length !== 2) {
                return false;
            }

            let destNode;

            // level low
            if (body.type === 'BlockStatement'
                && body.body.length === 1
                && body.body[0].type === 'ReturnStatement'
                && (destNode = body.body[0].argument)
                && destNode.type === 'SequenceExpression'
                && destNode.expressions.length === 2
                && destNode.expressions[0].type === 'AssignmentExpression'
                && destNode.expressions[1].type === 'CallExpression'
                && destNode.expressions[0].left.type === 'Identifier'
                && destNode.expressions[1].callee.type === 'Identifier'
                && destNode.expressions[0].left.name === destNode.expressions[1].callee.name) {
                //
                return true;
            }

            // level low+
            // ...

            return false;
        },
        /**
         * 添加加密函数
         * @param {NodePath} path FunctionDeclaration | FunctionExpression
         */
        addEncryptFunction(path) {
            let node = path.node;
            let destId = node.type === 'FunctionDeclaration' ? node.id : node.declarations[0].id;

            // 找到上一个数组 e.g. let coreFuncKeyFunc=[]; 必须
            // 找到上一个/下一个数组后紧跟的立即函数 (function(a,b){}) 可选
            let path1 = null;
            let path2 = null;
            let prevPaths = path.getAllPrevSiblings();
            let findPath2Callback = (value) => value.node.type === 'ExpressionStatement'
                && value.node.expression.type === 'CallExpression'
                && value.node.expression.callee.type === 'FunctionExpression'
                && value.node.expression.callee.params.length === 2
                && value.node.expression.arguments.length === 2
                && value.node.expression.arguments[0].type === 'Identifier';
            let pathIndex1 = prevPaths.findIndex((value) => value.node.type === 'VariableDeclaration'
                && value.node.declarations.length === 1
                && value.node.declarations[0].init.type === 'ArrayExpression');
            let pathIndex2 = prevPaths.findIndex(findPath2Callback);
            if (pathIndex2 === -1) {
                let nextPaths = path.getAllNextSiblings();
                pathIndex2 = nextPaths.findIndex(findPath2Callback);
                path2 = nextPaths[pathIndex2];
            } else {
                path2 = prevPaths[pathIndex2];
            }

            path1 = prevPaths[pathIndex1];

            if (path1) {
                let gr1 = generate(path1.node)
                let gr2 = path2 ? generate(path2.node) : {code: ''};
                let gr3 = generate(node);
                let code = gr1.code + gr2.code + gr3.code;

                // 去除代码检测(会引起堆栈溢出) 只要正则表达式任意通过即可(e.g. .)
                // - '\x5cw+\x20*\x5c(\x5c)\x20*{\x5cw+\x20*'
                // - '[\x27|\x22].+[\x27|\x22];?\x20*}'
                code = code.replace('\\x5cw+\\x20*\\x5c(\\x5c)\\x20*{\\x5cw+\\x20*', '').replace('[\\x27|\\x22].+[\\x27|\\x22];?\\x20*}', '.');

                global.eval(code);
                cache.coreRefPaths.push(path1);
                if (path2) {
                    cache.coreRefPaths.push(path2);
                }

                cache.corePaths[destId.name] = path;
                path1.skip();
            }
        },
        /**
         *
         * @param statement
         * @param arguments_
         * @returns {Node|null}
         */
        getFunctionExpressionCallNode(statement, arguments_) {
            let destNode;
            // 两种情况:
            // - 仅有一条return语句
            // - 无用的变量声明, return语句
            if (statement.body.type === 'BlockStatement'
                && (destNode = statement.body)
                && ((destNode.body.length === 1
                    && destNode.body[0].type === 'ReturnStatement'
                    && (destNode = destNode.body[0]))
                    || (destNode.body.length === 2
                        && destNode.body[0].type === 'VariableDeclaration'
                        && destNode.body[1].type === 'ReturnStatement'
                        && (destNode = destNode.body[1])))) {
                // e.g. a + b
                if (destNode.argument.type === 'BinaryExpression'
                    && arguments_.length === 2) {
                    return types.binaryExpression(destNode.argument.operator, arguments_[0], arguments_[1]);
                } else if (destNode.argument.type === 'Identifier') {
                    // e.g.
                    // function a(x){return x};
                    // a(123);
                    // ->
                    // 123
                    let argumentIndex = utils.indexOfArgument(statement.params, destNode.argument.name);
                    if (argumentIndex > -1) {
                        return arguments_[argumentIndex];
                    }
                } else if (destNode.argument.type.endsWith('Literal')) {
                    return destNode.argument;
                } else if (destNode.argument.type === 'CallExpression') {
                    // Replace call function
                    // - call(1)
                    // - proxyObj.call(1)
                    destNode = destNode.argument;
                    if (destNode.callee.type === 'Identifier') {
                        let argumentIndex = utils.indexOfArgument(statement.params, destNode.callee.name);
                        if (argumentIndex > -1) {
                            let newCallee = arguments_[argumentIndex];
                            let newArguments = arguments_.filter((item, index) => index !== argumentIndex);
                            return types.callExpression(newCallee, newArguments);
                        }
                    } else if (destNode.callee.type === 'MemberExpression'
                        && destNode.callee.object.type === 'Identifier'
                        && destNode.callee.property.type === 'Identifier') {
                        return types.callExpression(destNode.callee, arguments_);
                    }
                }
            }
        },
        /**
         * 替换call类型对象成员
         * @param property ObjectProperty
         * @param {array} arguments_
         * @returns {Node|null} 如果不建议则返回null
         */
        getReplacedCallObjectPropertyNode(property, arguments_) {
            if (property.type !== 'ObjectProperty') {
                throw new Error('Must be "ObjectProperty"');
            }

            switch (property.value.type) {
                case 'BooleanLiteral':
                case 'NumberLiteral':
                case 'StringLiteral':
                    return property.value;
                case 'FunctionExpression':
                    return context.getFunctionExpressionCallNode(property.value, arguments_);
                default:
                    break
            }
            return null;
        },
    };

    traverse(ast, visitorDetectEncrypt);
    traverse(ast, visitor);
    traverse(ast, visitorBeautify);
    context.cleanup();

    let generateOptions = {};
    let {code} = generate(ast, generateOptions);
    return code;
}

exports.optimize = optimize;