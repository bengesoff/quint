/*
 * A compiler to the runtime environment.
 *
 * Igor Konnov, Informal Systems, 2022-2023
 *
 * Copyright (c) Informal Systems 2022-2023. All rights reserved.
 * Licensed under the Apache 2.0.
 * See License.txt in the project root for license information.
 */

import { Either, left, right } from '@sweet-monads/either'
import {
  ErrorMessage,
  Loc,
  fromIrErrorMessage,
  parse,
  parsePhase2sourceResolution,
  parsePhase3importAndNameResolution,
} from '../parsing/quintParserFrontend'
import { Computable, ComputableKind, kindName } from './runtime'
import { ExecutionListener } from './trace'
import { FlatModule, IrErrorMessage, QuintDeclaration, QuintDef, QuintEx, QuintModule } from '../ir/quintIr'
import { CompilerVisitor, EvaluationState, newEvaluationState } from './impl/compilerImpl'
import { walkDefinition } from '../ir/IRVisitor'
import { LookupTable } from '../names/base'
import { AnalysisOutput, analyzeInc, analyzeModules } from '../quintAnalyzer'
import { mkErrorMessage } from '../cliCommands'
import { IdGenerator, newIdGenerator } from '../idGenerator'
import { SourceLookupPath, fileSourceResolver, stringSourceResolver } from '../parsing/sourceResolver'
import { Rng } from '../rng'
import { flattenModules } from '../flattening/fullFlattener'
import { QuintError } from '../quintError'

/**
 * The name of the shadow variable that stores the last found trace.
 */
export const lastTraceName = 'q::lastTrace'

/**
 * The name of a definition that wraps the user input, e.g., in REPL.
 */
export const inputDefName: string = 'q::input'

/**
 * A compilation context returned by 'compile'.
 */
export interface CompilationContext {
  // the lookup table to query for values and definitions
  lookupTable: LookupTable
  // messages that are produced during parsing
  syntaxErrors: ErrorMessage[]
  // messages that are produced by static analysis
  analysisErrors: ErrorMessage[]
  // messages that are produced during compilation
  compileErrors: ErrorMessage[]
  // messages that get populated as the compiled code is executed
  getRuntimeErrors: () => ErrorMessage[]
  // The state of pre-compilation phases.
  compilationState: CompilationState
  // The state of the compiler visitor.
  evaluationState: EvaluationState
}

/**
 * A data structure that holds the state of the compilation process.
 */
export interface CompilationState {
  // The ID generator used during compilation.
  idGen: IdGenerator
  // A list of modules as they are constructed, without flattening. This is
  // needed to derive correct name resolution during incremental compilation in
  // a flattened context.
  originalModules: QuintModule[]
  // A list of flattened modules.
  modules: FlatModule[]
  // The name of the main module.
  mainName?: string
  // The source map for the compiled code.
  sourceMap: Map<bigint, Loc>
  // The output of the Quint analyzer.
  analysisOutput: AnalysisOutput
}

/* An empty initial compilation state */
export function newCompilationState(): CompilationState {
  return {
    idGen: newIdGenerator(),
    originalModules: [],
    modules: [],
    sourceMap: new Map(),
    analysisOutput: {
      types: new Map(),
      effects: new Map(),
      modes: new Map(),
    },
  }
}

export function errorContextFromMessage(listener: ExecutionListener): (errors: ErrorMessage[]) => CompilationContext {
  const compilationState = newCompilationState()
  const evaluationState = newEvaluationState(listener)
  return (errs: ErrorMessage[]) => {
    return {
      lookupTable: new Map(),
      syntaxErrors: errs,
      analysisErrors: [],
      compileErrors: [],
      getRuntimeErrors: () => [],
      compilationState,
      evaluationState,
    }
  }
}

export function contextNameLookup(
  context: Map<string, Computable>,
  defName: string,
  kind: ComputableKind
): Either<string, Computable> {
  const value = context.get(kindName(kind, defName))
  if (!value) {
    console.log(`key = ${kindName(kind, defName)}`)
    return left(`No value for definition ${defName}`)
  } else {
    return right(value)
  }
}

/**
 * Compile Quint defs to JS runtime objects from the parsed and type-checked
 * data structures. This is a user-facing function. In case of an error, the
 * error messages are passed to an error handler and the function returns
 * undefined.
 *
 * @param compilationState the state of the compilation process
 * @param evaluationState the state of the compiler visitor
 * @param lookupTable lookup table as produced by the parser
 * @param rand the random number generator
 * @param defs the definitions to compile
 * @returns the compilation context
 */
export function compile(
  compilationState: CompilationState,
  evaluationState: EvaluationState,
  lookupTable: LookupTable,
  rand: (bound: bigint) => bigint,
  defs: QuintDef[]
): CompilationContext {
  const { sourceMap, analysisOutput } = compilationState

  const visitor = new CompilerVisitor(lookupTable, analysisOutput.types, rand, evaluationState)

  defs.forEach(def => walkDefinition(visitor, def))

  return {
    lookupTable,
    syntaxErrors: [],
    analysisErrors: [],
    compileErrors: visitor.getCompileErrors().map(fromIrErrorMessage(sourceMap)),
    getRuntimeErrors: () => {
      return visitor.getRuntimeErrors().splice(0).map(fromIrErrorMessage(sourceMap))
    },
    compilationState,
    evaluationState: visitor.getEvaluationState(),
  }
}

/**
 * Compile a single Quint expression, given a non-empty compilation and
 * evaluation state. That is, those states should have the results of the
 * compilation of at least one module.
 *
 * @param state - The current compilation state
 * @param evaluationState - The current evaluation state
 * @param rng - The random number generator
 * @param mainPath the lookup path of the main module
 * @param expr - The Quint exporession to be compiled
 *
 * @returns A compilation context with the compiled expression or its errors
 */
export function compileExpr(
  state: CompilationState,
  evaluationState: EvaluationState,
  rng: Rng,
  mainPath: SourceLookupPath,
  expr: QuintEx
): CompilationContext {
  // Create a definition to encapsulate the parsed expression.
  // Note that the expression may contain nested definitions.
  // Hence, we have to compile it via an auxilliary definition.
  const def: QuintDef = { kind: 'def', qualifier: 'action', name: inputDefName, expr, id: state.idGen.nextId() }
  return compileDecl(state, evaluationState, rng, mainPath, def)
}

/**
 * Compile a single Quint definition, given a non-empty compilation and
 * evaluation state. That is, those states should have the results of the
 * compilation of at least one module.
 *
 * @param state - The current compilation state
 * @param evaluationState - The current evaluation state
 * @param rng - The random number generator
 * @param mainPath the lookup path of the main module
 * @param decl - The Quint declaration to be compiled
 *
 * @returns A compilation context with the compiled definition or its errors
 */
export function compileDecl(
  state: CompilationState,
  evaluationState: EvaluationState,
  rng: Rng,
  mainPath: SourceLookupPath,
  decl: QuintDeclaration
): CompilationContext {
  if (state.originalModules.length === 0 || state.modules.length === 0) {
    throw new Error('No modules in state')
  }

  // Define a new module list with the new definition in the main module,
  // ensuring the original object is not modified
  const originalModules = state.originalModules.map(m => {
    if (m.name === state.mainName) {
      return { ...m, declarations: [...m.declarations, decl] }
    }
    return m
  })

  const mainModule = state.modules.find(m => m.name === state.mainName)!
  const resolver = fileSourceResolver()

  // Generate a new identifier that is used as a watermark.
  // All definitions that are above the watermark will be new definitions,
  // which we have to compile.
  const watermarkId = state.idGen.nextId()
  console.log(`watermarkId = ${watermarkId}`)

  // We need to resolve names for this new definition. Incremental name
  // resolution is not our focus now, so just resolve everything again.
  return parsePhase2sourceResolution(state.idGen, resolver, mainPath,
       { modules: originalModules, sourceMap: state.sourceMap })
    .chain(parsePhase3importAndNameResolution)
    .mapLeft(errorContextFromMessage(evaluationState.listener))
    .map(({ sourceMap, table, modules: originalAndNewModules }) => {
      // The most common case, originalAndNewModules == originalModules.
      // However, if decl is an 'import ... from...',
      // then originalModules is a subset of originalAndNewModules.
      console.log(`new watermark = ${state.idGen.nextId()}`)
      // find all new declarations that might have arrived via an import
      const newDeclsToAnalyze =
        originalAndNewModules.map(m => m.declarations.filter(d => d.id > watermarkId)).flat()
      // the declaration has been there already, so we have to add it too
      newDeclsToAnalyze.push(decl)
      console.log(`Found ${newDeclsToAnalyze.length} definitions to analyze`)
      const [analysisErrors, analysisOutput] =
        newDeclsToAnalyze.reduce(([prevErr, prevOut], d) => {
            const [err, out] = analyzeInc(prevOut, table, d)
            return [ prevErr.concat(err), out ]
          },
          [ [] as [bigint, QuintError][], state.analysisOutput ]
        )

      // Flatten instances, imports, and exports.
      // Note that 'import ... from' is resolved at phase 2.
      // The important thing to remember is that flattening prunes unused definitions.
      const {
        flattenedModules: flatModules,
        flattenedTable,
        flattenedAnalysis,
      } = flattenModules(originalAndNewModules, table, state.idGen, sourceMap, analysisOutput)

      flatModules.forEach(m => console.log(m.name))

      const newState = {
        ...state,
        analysisOutput: flattenedAnalysis,
        modules: flatModules,
        originalModules: originalAndNewModules,
        sourceMap,
      }

      // Filter definitions that were not compiled yet
      const flatDefinitions = flatModules.find(m => m.name === state.mainName)!.declarations
      const defsToCompileOld = flatDefinitions.filter(d => !mainModule.declarations.some(d2 => d2.id === d.id))
      console.log(`Found ${defsToCompileOld.length} definitions to compile the old way`)
      const defsToCompile = flatModules.map(m => m.declarations.filter(d => d.id > watermarkId)).flat()
      console.log(`Found ${defsToCompile.length} definitions to compile`)

      const ctx = compile(newState, evaluationState, flattenedTable, rng.next, defsToCompile)

      const errorLocator = mkErrorMessage(state.sourceMap)
      return {
        ...ctx,
        analysisErrors: Array.from(analysisErrors, errorLocator),
      }
    }).value // We produce a compilation context in any case
}

/**
 * Parse a string that contains Quint modules and compile it to executable
 * objects. This is a user-facing function. In case of an error, the error
 * messages are passed to an error handler and the function returns undefined.
 *
 * @param code text that stores one or several Quint modules,
 *        which should be parseable without any context
 * @param mainName the name of the module that may contain state varibles
 * @param mainPath the lookup path of the main module
 * @param execListener execution listener
 * @param rand the random number generator
 * @returns the compilation context
 */
export function compileFromCode(
  idGen: IdGenerator,
  code: string,
  mainName: string,
  mainPath: SourceLookupPath,
  execListener: ExecutionListener,
  rand: (bound: bigint) => bigint
): CompilationContext {
  // parse the module text
  return (
    parse(idGen, '<module_input>', mainPath, code)
      // On errors, we'll produce the computational context up to this point
      .mapLeft(errorContextFromMessage(execListener))
      .chain(
        parseData => {
          const { modules, table, sourceMap } = parseData
          const [analysisErrors, analysisOutput] = analyzeModules(table, modules)

          const { flattenedModules, flattenedTable, flattenedAnalysis } = flattenModules(
            modules,
            table,
            idGen,
            sourceMap,
            analysisOutput
          )
          const compilationState: CompilationState = {
            originalModules: modules,
            modules: flattenedModules,
            mainName,
            sourceMap,
            analysisOutput: flattenedAnalysis,
            idGen,
          }

          const main = flattenedModules.find(m => m.name === mainName)
          // when the main module is not found, we will report an error
          const mainNotFoundError: IrErrorMessage[] = main
            ? []
            : [
                {
                  explanation: `Main module ${mainName} not found`,
                  refs: [],
                },
              ]
          const defsToCompile = main ? main.declarations : []
          const ctx = compile(compilationState, newEvaluationState(execListener), flattenedTable, rand, defsToCompile)

          const errorLocator = mkErrorMessage(sourceMap)
          return right({
            ...ctx,
            compileErrors: ctx.compileErrors.concat(mainNotFoundError.map(fromIrErrorMessage(sourceMap))),
            analysisErrors: Array.from(analysisErrors, errorLocator),
          })
        }
        // we produce CompilationContext in any case
      ).value
  )
}
