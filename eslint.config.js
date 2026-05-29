// @ts-check
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

/** @type {import("eslint").Linter.Config[]} */
module.exports = [
    {
        ignores: ['dist/**', 'visualizer/**', 'node_modules/**'],
    },
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parser: tsparser,
            parserOptions: {
                project: './tsconfig.json',
            },
        },
        plugins: {
            '@typescript-eslint': tseslint,
        },
        rules: {
            // Enforce 4-space indentation
            indent: ['error', 4, { SwitchCase: 1 }],

            // Always require curly braces for if/else/for/while
            curly: ['error', 'all'],

            // Require explicit return types on functions
            '@typescript-eslint/explicit-function-return-type': [
                'error',
                {
                    allowExpressions: false,
                    allowTypedFunctionExpressions: false,
                    allowHigherOrderFunctions: false,
                },
            ],

            // Require type annotations on variables, parameters, and properties
            '@typescript-eslint/typedef': [
                'error',
                {
                    arrayDestructuring: false,
                    arrowParameter: true,
                    memberVariableDeclaration: true,
                    objectDestructuring: false,
                    parameter: true,
                    propertyDeclaration: true,
                    variableDeclaration: true,
                    variableDeclarationIgnoreFunction: false,
                },
            ],
        },
    },
];
