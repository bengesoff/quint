/**
 * The commands for the quint CLI
 *
 * See the description at:
 * https://github.com/informalsystems/quint/blob/main/doc/quint.md
 *
 * @author Igor Konnov, Gabriela Moreira, Shon Feder, Informal Systems, 2021-2023
 */

import { existsSync, readFileSync, writeFileSync } from 'fs'
import JSONbig from 'json-bigint'
import { basename, dirname, resolve } from 'path'
import { cwd } from 'process'
import chalk from 'chalk'

import {
  SourceMap,
  compactSourceMap,
  parseDefOrThrow,
  parseExpressionOrDeclaration,
  parsePhase1fromText,
  parsePhase2sourceResolution,
  parsePhase3importAndNameResolution,
  parsePhase4toposort,
} from './parsing/quintParserFrontend'
import { ErrorMessage } from './ErrorMessage'

import { Either, left, mergeInMany, right } from '@sweet-monads/either'
import assert, { fail } from 'assert'
import { EffectScheme } from './effects/base'
import { LookupTable } from './names/base'
import { ReplOptions, quintRepl } from './repl'
import { FlatModule, OpQualifier, QuintBool, QuintEx, QuintModule } from './ir/quintIr'
import { TypeScheme } from './types/base'
import { createFinders, formatError } from './errorReporter'
import { DocumentationEntry, produceDocs, toMarkdown } from './docs'
import { QuintError, quintErrorToString } from './quintError'
import { TestOptions, TestResult } from './runtime/testing'
import { IdGenerator, newIdGenerator, zerog } from './idGenerator'
import { Outcome, SimulatorOptions } from './simulation'
import { ofItf, toItf } from './itf'
import { printExecutionFrameRec, printTrace, terminalWidth } from './graphics'
import { verbosity } from './verbosity'
import { Rng, newRng } from './rng'
import { fileSourceResolver } from './parsing/sourceResolver'
import { verify } from './quintVerifier'
import { flattenModules } from './flattening/fullFlattener'
import { AnalysisOutput, analyzeInc, analyzeModules } from './quintAnalyzer'
import { ExecutionFrame, newTraceRecorder } from './runtime/trace'
import { flow, isEqual, uniqWith } from 'lodash'
import { Maybe, just, none } from '@sweet-monads/maybe'
import { compileToTlaplus } from './compileToTlaplus'
import { Evaluator } from './runtime/impl/evaluator'
import { NameResolver } from './names/resolver'
import { walkExpression } from './ir/IRVisitor'

export type stage =
  | 'loading'
  | 'parsing'
  | 'typechecking'
  | 'testing'
  | 'running'
  | 'compiling'
  | 'outputting target'
  | 'documentation'

/** The data from a ProcedureStage that may be output to --out */
interface OutputStage {
  stage: stage
  // the modules and the lookup table produced by 'parse'
  modules?: QuintModule[]
  table?: LookupTable
  // the tables produced by 'typecheck'
  types?: Map<bigint, TypeScheme>
  effects?: Map<bigint, EffectScheme>
  modes?: Map<bigint, OpQualifier>
  // Test names output produced by 'test'
  passed?: string[]
  failed?: string[]
  ignored?: string[]
  // Possible results from 'run'
  status?: 'ok' | 'violation' | 'failure' | 'error'
  trace?: QuintEx[]
  seed?: bigint
  /* Docstrings by definition name by module name */
  documentation?: Map<string, Map<string, DocumentationEntry>>
  errors?: ErrorMessage[]
  warnings?: any[] // TODO it doesn't look like this is being used for anything. Should we remove it?
  sourceCode?: Map<string, string> // Should not be printed, only used in formatting errors
}

// Extract just the parts of a ProcedureStage that we use for the output
// See https://stackoverflow.com/a/39333479/1187277
const pickOutputStage = ({
  stage,
  warnings,
  modules,
  table,
  types,
  effects,
  errors,
  documentation,
  passed,
  failed,
  ignored,
  status,
  trace,
  seed,
}: ProcedureStage) => {
  return {
    stage,
    warnings,
    modules,
    table,
    types,
    effects,
    errors,
    documentation,
    passed,
    failed,
    ignored,
    status,
    trace,
    seed,
  }
}

interface ProcedureStage extends OutputStage {
  args: any
}

interface LoadedStage extends ProcedureStage {
  // Path to the source file
  path: string
  sourceCode: Map<string, string>
}

interface ParsedStage extends LoadedStage {
  modules: QuintModule[]
  defaultModuleName: Maybe<string>
  sourceMap: SourceMap
  table: LookupTable
  resolver: NameResolver
  idGen: IdGenerator
}

interface TypecheckedStage extends ParsedStage {
  types: Map<bigint, TypeScheme>
  effects: Map<bigint, EffectScheme>
  modes: Map<bigint, OpQualifier>
}

interface CompiledStage extends TypecheckedStage, AnalysisOutput {
  mainModule: FlatModule
}

interface TestedStage extends LoadedStage {
  // the names of the passed tests
  passed: string[]
  // the names of the failed tests
  failed: string[]
  // the names of the ignored tests
  ignored: string[]
}

// Data resulting from stages that can produce a trace
interface TracingStage extends LoadedStage {
  trace?: QuintEx[]
}

interface DocumentationStage extends LoadedStage {
  documentation?: Map<string, Map<string, DocumentationEntry>>
}

// A procedure stage which is guaranteed to have `errors` and `sourceCode`
interface ErrorData extends ProcedureStage {
  errors: ErrorMessage[]
  sourceCode: Map<string, string>
}

type ErrResult = { msg: string; stage: ErrorData }

function cliErr<Stage>(msg: string, stage: ErrorData): Either<ErrResult, Stage> {
  return left({ msg, stage })
}

export type CLIProcedure<Stage> = Either<ErrResult, Stage>

/** Load a file into a string
 *
 * @param args the CLI arguments parsed by yargs */
export async function load(args: any): Promise<CLIProcedure<LoadedStage>> {
  const stage: ProcedureStage = { stage: 'loading', args }
  if (existsSync(args.input)) {
    try {
      const path = resolve(cwd(), args.input)
      const sourceCode = readFileSync(path, 'utf8')
      return right({
        ...stage,
        args,
        path,
        sourceCode: new Map([[path, sourceCode]]),
        warnings: [],
      })
    } catch (err: unknown) {
      return cliErr(`file ${args.input} could not be opened due to ${err}`, {
        ...stage,
        errors: [],
        sourceCode: new Map(),
      })
    }
  } else {
    return cliErr(`file ${args.input} does not exist`, { ...stage, errors: [], sourceCode: new Map() })
  }
}

/**
 * Parse a Quint specification.
 *
 * @param loaded the procedure stage produced by `load`
 */
export async function parse(loaded: LoadedStage): Promise<CLIProcedure<ParsedStage>> {
  const { args, sourceCode, path } = loaded
  const text = sourceCode.get(path)!
  const parsing = { ...loaded, stage: 'parsing' as stage }
  const idGen = newIdGenerator()
  return flow([
    () => {
      const phase1Data = parsePhase1fromText(idGen, text, path)
      // if there is exactly one module in the original text, make it the main one
      const defaultModuleName = phase1Data.modules.length === 1 ? just(phase1Data.modules[0].name) : none()
      return { ...phase1Data, defaultModuleName }
    },
    phase1Data => {
      const resolver = fileSourceResolver(sourceCode)
      const mainPath = resolver.lookupPath(dirname(path), basename(path))
      return parsePhase2sourceResolution(idGen, resolver, mainPath, phase1Data)
    },
    phase2Data => {
      if (args.sourceMap) {
        // Write source map to the specified file
        writeToJson(args.sourceMap, compactSourceMap(phase2Data.sourceMap))
      }
      return parsePhase3importAndNameResolution(phase2Data)
    },
    phase3Data => parsePhase4toposort(phase3Data),
    phase4Data => ({ ...parsing, ...phase4Data, idGen }),
    result => {
      if (result.errors.length > 0) {
        const newErrorMessages = result.errors.map(mkErrorMessage(result.sourceMap))
        const errorMessages = parsing.errors ? parsing.errors.concat(newErrorMessages) : newErrorMessages
        return left({ msg: 'parsing failed', stage: { ...result, errors: errorMessages } })
      }

      return right(result)
    },
  ])()
}

export function mkErrorMessage(sourceMap: SourceMap): (_: QuintError) => ErrorMessage {
  return error => {
    const loc = error.reference ? sourceMap.get(error.reference) : undefined
    return {
      explanation: quintErrorToString(error),
      locs: loc ? [loc] : [],
    }
  }
}
/**
 * Check types and effects of a Quint specification.
 *
 * @param parsed the procedure stage produced by `parse`
 */
export async function typecheck(parsed: ParsedStage): Promise<CLIProcedure<TypecheckedStage>> {
  const { table, modules, sourceMap } = parsed

  const [errorMap, result] = analyzeModules(table, modules)

  const typechecking = { ...parsed, ...result, stage: 'typechecking' as stage }
  if (errorMap.length === 0) {
    return right(typechecking)
  } else {
    const errors = errorMap.map(mkErrorMessage(sourceMap))
    return cliErr('typechecking failed', { ...typechecking, errors })
  }
}

/**
 * Run REPL.
 *
 * @param _argv parameters as provided by yargs
 */
export async function runRepl(_argv: any) {
  let filename: string | undefined = undefined
  let moduleName: string | undefined = undefined
  if (_argv.require) {
    // quint -r FILE.qnt or quint -r FILE.qnt::MODULE
    const m = /^(.*?)(?:|::([a-zA-Z_]\w*))$/.exec(_argv.require)
    if (m) {
      ;[filename, moduleName] = m.slice(1, 3)
    }
  }
  const options: ReplOptions = {
    preloadFilename: filename,
    importModule: moduleName,
    verbosity: _argv.quiet ? 0 : _argv.verbosity,
  }
  quintRepl(process.stdin, process.stdout, options)
}

/**
 * Run the tests. We imitate the output of mocha.
 *
 * @param typedStage the procedure stage produced by `typecheck`
 */
export async function runTests(prev: TypecheckedStage): Promise<CLIProcedure<TestedStage>> {
  const testing = { ...prev, stage: 'testing' as stage }
  const verbosityLevel = deriveVerbosity(prev.args)
  const mainName = guessMainModule(prev)
  const main = prev.modules.find(m => m.name === mainName)
  if (!main) {
    const error: QuintError = { code: 'QNT405', message: `Main module ${mainName} not found` }
    return cliErr('Argument error', { ...testing, errors: [mkErrorMessage(prev.sourceMap)(error)] })
  }

  const rngOrError = mkRng(prev.args.seed)
  if (rngOrError.isLeft()) {
    return cliErr(rngOrError.value, { ...testing, errors: [] })
  }
  const rng = rngOrError.unwrap()

  const matchFun = (n: string): boolean => isMatchingTest(testing.args.match, n)
  const maxSamples = testing.args.maxSamples
  const options: TestOptions = {
    testMatch: matchFun,
    maxSamples: testing.args.maxSamples,
    rng,
    verbosity: verbosityLevel,
    onTrace: (index: number) => (name: string, status: string, vars: string[], states: QuintEx[]) => {
      if (outputTemplate) {
        const filename = expandNamedOutputTemplate(outputTemplate, name, index, { autoAppend: prev.args.nTraces > 1 })
        const trace = toItf(vars, states)
        if (trace.isRight()) {
          const jsonObj = addItfHeader(prev.args.input, status, trace.value)
          writeToJson(filename, jsonObj)
        } else {
          console.error(`ITF conversion failed on ${name}: ${trace.value}`)
        }
      }
    },
  }

  const out = console.log

  const outputTemplate = testing.args.outItf

  // Start the Timer and being running the tests
  const startMs = Date.now()

  if (verbosity.hasResults(verbosityLevel)) {
    out(`\n  ${mainName}`)
  }

  const testDefs = Array.from(prev.resolver.collector.definitionsByModule.get(mainName)!.values())
    .flat()
    .filter(d => d.kind === 'def' && options.testMatch(d.name))

  const evaluator = new Evaluator(testing.table, newTraceRecorder(verbosityLevel, rng, 1), rng)
  const results = testDefs.map((def, index) => {
    return evaluator.test(def, maxSamples, options.onTrace(index))
  })

  // We're finished running the tests
  const elapsedMs = Date.now() - startMs

  // output the status for every test
  let nFailures = 1
  if (verbosity.hasResults(verbosityLevel)) {
    results.forEach(res => {
      if (res.status === 'passed') {
        out(`    ${chalk.green('ok')} ${res.name} passed ${res.nsamples} test(s)`)
      }
      if (res.status === 'failed') {
        const errNo = chalk.red(nFailures)
        out(`    ${errNo}) ${res.name} failed after ${res.nsamples} test(s)`)
        nFailures++
      }
    })
  }

  const passed = results.filter(r => r.status === 'passed')
  const failed = results.filter(r => r.status === 'failed')
  const ignored = results.filter(r => r.status === 'ignored')
  const namedErrors: [TestResult, ErrorMessage][] = failed.reduce(
    (acc: [TestResult, ErrorMessage][], failure) =>
      acc.concat(failure.errors.map(e => [failure, mkErrorMessage(testing.sourceMap)(e)])),
    []
  )

  // output the statistics banner
  if (verbosity.hasResults(verbosityLevel)) {
    out('')
    if (passed.length > 0) {
      out(chalk.green(`  ${passed.length} passing`) + chalk.gray(` (${elapsedMs}ms)`))
    }
    if (failed.length > 0) {
      out(chalk.red(`  ${failed.length} failed`))
    }
    if (ignored.length > 0) {
      out(chalk.gray(`  ${ignored.length} ignored`))
    }
  }

  const stage = {
    ...testing,
    passed: passed.map(r => r.name),
    failed: failed.map(r => r.name),
    ignored: ignored.map(r => r.name),
    errors: [],
  }

  // Nothing failed, so we are OK, and can exit early
  if (failed.length === 0) {
    return right(stage)
  }

  // We know that there are errors, so report as required by the verbosity configuration
  if (verbosity.hasTestDetails(verbosityLevel)) {
    const code = prev.sourceCode!
    const finders = createFinders(code)
    const columns = !prev.args.out ? terminalWidth() : 80
    out('')
    namedErrors.forEach(([testResult, err], index) => {
      const details = formatError(code, finders, err)
      // output the header
      out(`  ${index + 1}) ${testResult.name}:`)
      const lines = details.split('\n')
      // output the first two lines in red
      lines.slice(0, 2).forEach(l => out(chalk.red('      ' + l)))

      if (verbosity.hasActionTracking(verbosityLevel)) {
        out('')
        testResult.frames.forEach((f, index) => {
          out(`[${chalk.bold('Frame ' + index)}]`)
          const console = {
            width: columns,
            out: (s: string) => process.stdout.write(s),
          }
          printExecutionFrameRec(console, f, [])
          out('')
        })

        if (testResult.frames.length == 0) {
          out('    [No execution]')
        }
      }
      // output the seed
      out(chalk.gray(`    Use --seed=0x${testResult.seed.toString(16)} --match=${testResult.name} to repeat.`))
    })
    out('')
  }

  if (verbosity.hasHints(options.verbosity) && !verbosity.hasActionTracking(options.verbosity)) {
    out(chalk.gray(`\n  Use --verbosity=3 to show executions.`))
    out(chalk.gray(`  Further debug with: quint test --verbosity=3 ${prev.args.input}`))
  }

  return cliErr('Tests failed', stage)
}

// Print a counterexample if the appropriate verbosity is set
function maybePrintCounterExample(verbosityLevel: number, states: QuintEx[], frames: ExecutionFrame[] = []) {
  if (verbosity.hasStateOutput(verbosityLevel)) {
    console.log(chalk.gray('An example execution:\n'))
    const myConsole = {
      width: terminalWidth(),
      out: (s: string) => process.stdout.write(s),
    }
    printTrace(myConsole, states, frames)
  }
}

/**
 * Run the simulator.
 *
 * @param prev the procedure stage produced by `typecheck`
 */
export async function runSimulator(prev: TypecheckedStage): Promise<CLIProcedure<TracingStage>> {
  const simulator = { ...prev, stage: 'running' as stage }
  const startMs = Date.now()
  // Force disable output if `--out-itf` is set
  const verbosityLevel = prev.args.outItf ? 0 : deriveVerbosity(prev.args)
  const mainName = guessMainModule(prev)
  const main = prev.modules.find(m => m.name === mainName)
  if (!main) {
    const error: QuintError = { code: 'QNT405', message: `Main module ${mainName} not found` }
    return cliErr('Argument error', { ...prev, errors: [mkErrorMessage(prev.sourceMap)(error)] })
  }

  const rngOrError = mkRng(prev.args.seed)
  if (rngOrError.isLeft()) {
    return cliErr(rngOrError.value, { ...simulator, errors: [] })
  }
  const rng = rngOrError.unwrap()

  const options: SimulatorOptions = {
    init: prev.args.init,
    step: prev.args.step,
    invariant: prev.args.invariant,
    maxSamples: prev.args.maxSamples,
    maxSteps: prev.args.maxSteps,
    rng,
    verbosity: verbosityLevel,
    storeMetadata: prev.args.mbt,
    numberOfTraces: prev.args.nTraces,
    onTrace: (index: number, status: string, vars: string[], states: QuintEx[]) => {
      const itfFile: string | undefined = prev.args.outItf
      if (itfFile) {
        const filename = expandOutputTemplate(itfFile, index, { autoAppend: prev.args.nTraces > 1 })
        const trace = toItf(vars, states)
        if (trace.isRight()) {
          const jsonObj = addItfHeader(prev.args.input, status, trace.value)
          writeToJson(filename, jsonObj)
        } else {
          console.error(`ITF conversion failed on ${index}: ${trace.value}`)
        }
      }
    },
  }

  const recorder = newTraceRecorder(options.verbosity, options.rng, options.numberOfTraces)

  function toExpr(input: string): Either<QuintError, QuintEx> {
    const parseResult = parseExpressionOrDeclaration(input, '<input>', prev.idGen, prev.sourceMap)
    if (parseResult.kind !== 'expr') {
      return left({ code: 'QNT501', message: `Expected ${input} to be a valid expression` })
    }

    prev.resolver.switchToModule(mainName)
    walkExpression(prev.resolver, parseResult.expr)
    if (prev.resolver.errors.length > 0) {
      return left(prev.resolver.errors[0])
    }

    return right(parseResult.expr)
  }

  const argsParsingResult = mergeInMany([prev.args.init, prev.args.step, prev.args.invariant].map(toExpr))
  if (argsParsingResult.isLeft()) {
    return cliErr('Argument error', {
      ...simulator,
      errors: argsParsingResult.value.map(mkErrorMessage(new Map())),
    })
  }
  const [init, step, invariant] = argsParsingResult.value

  const evaluator = new Evaluator(prev.resolver.table, recorder, options.rng, options.storeMetadata)
  const evalResult = evaluator.simulate(
    init,
    step,
    invariant,
    prev.args.maxSamples,
    prev.args.maxSteps,
    prev.args.nTraces ?? 1
  )

  const elapsedMs = Date.now() - startMs

  const outcome: Outcome = evalResult.isRight()
    ? { status: (evalResult.value as QuintBool).value ? 'ok' : 'violation' }
    : { status: 'error', errors: [evalResult.value] }

  const states = recorder.bestTraces[0]?.frame?.args?.map(e => e.toQuintEx(zerog))
  const frames = recorder.bestTraces[0]?.frame?.subframes
  simulator.seed = recorder.bestTraces[0]?.seed

  recorder.bestTraces.forEach((trace, index) => {
    const maybeEvalResult = trace.frame.result
    if (maybeEvalResult.isLeft()) {
      return cliErr('Runtime error', {
        ...simulator,
        errors: [mkErrorMessage(simulator.sourceMap)(maybeEvalResult.value)],
      })
    }
    const quintExResult = maybeEvalResult.value.toQuintEx(prev.idGen)
    assert(quintExResult.kind === 'bool', 'invalid simulation produced non-boolean value ')
    const simulationSucceeded = quintExResult.value
    const status = simulationSucceeded ? 'ok' : 'violation'
    const states = trace.frame.args.map(e => e.toQuintEx(prev.idGen))

    options.onTrace(index, status, evaluator.varNames(), states)
  })

  switch (outcome.status) {
    case 'error':
      return cliErr('Runtime error', {
        ...simulator,
        status: outcome.status,
        trace: states,
        errors: outcome.errors.map(mkErrorMessage(prev.sourceMap)),
      })

    case 'ok':
      maybePrintCounterExample(verbosityLevel, states, frames)
      if (verbosity.hasResults(verbosityLevel)) {
        console.log(chalk.green('[ok]') + ' No violation found ' + chalk.gray(`(${elapsedMs}ms).`))
        if (verbosity.hasHints(verbosityLevel)) {
          console.log(chalk.gray('You may increase --max-samples and --max-steps.'))
          console.log(chalk.gray('Use --verbosity to produce more (or less) output.'))
        }
      }

      return right({
        ...simulator,
        status: outcome.status,
        trace: states,
      })

    case 'violation':
      maybePrintCounterExample(verbosityLevel, states, frames)
      if (verbosity.hasResults(verbosityLevel)) {
        console.log(chalk.red(`[violation]`) + ' Found an issue ' + chalk.gray(`(${elapsedMs}ms).`))

        if (verbosity.hasHints(verbosityLevel)) {
          console.log(chalk.gray('Use --verbosity=3 to show executions.'))
        }
      }

      return cliErr('Invariant violated', {
        ...simulator,
        status: outcome.status,
        trace: states,
        errors: [],
      })
  }
}

/**  Compile to a flattened module, that includes the special q::* declarations
 *
 * @param typechecked the output of a preceding type checking stage
 */
export async function compile(typechecked: TypecheckedStage): Promise<CLIProcedure<CompiledStage>> {
  const args = typechecked.args
  const mainName = guessMainModule(typechecked)
  const main = typechecked.modules.find(m => m.name === mainName)
  if (!main) {
    return cliErr(`module ${mainName} does not exist`, { ...typechecked, errors: [], sourceCode: new Map() })
  }

  // Wrap init, step, invariant and temporal properties in other definitions,
  // to make sure they are not considered unused in the main module and,
  // therefore, ignored by the flattener
  const extraDefsAsText = [`action q::init = ${args.init}`, `action q::step = ${args.step}`]

  if (args.invariant) {
    extraDefsAsText.push(`val q::inv = and(${args.invariant})`)
  }
  if (args.temporal) {
    extraDefsAsText.push(`temporal q::temporalProps = and(${args.temporal})`)
  }

  const extraDefs = extraDefsAsText.map(d => parseDefOrThrow(d, typechecked.idGen, new Map()))
  main.declarations.push(...extraDefs)

  // We have to update the lookup table and analysis result with the new definitions. This is not ideal, and the problem
  // is that is hard to add this definitions in the proper stage, in our current setup. We should try to tackle this
  // while solving #1052.
  const resolutionResult = parsePhase3importAndNameResolution({ ...typechecked, errors: [] })
  if (resolutionResult.errors.length > 0) {
    const errors = resolutionResult.errors.map(mkErrorMessage(typechecked.sourceMap))
    return cliErr('name resolution failed', { ...typechecked, errors })
  }

  typechecked.table = resolutionResult.table
  analyzeInc(typechecked, typechecked.table, extraDefs)

  // Flatten modules, replacing instances, imports and exports with their definitions
  const { flattenedModules, flattenedTable, flattenedAnalysis } = flattenModules(
    typechecked.modules,
    typechecked.table,
    typechecked.idGen,
    typechecked.sourceMap,
    typechecked
  )

  // Pick the main module
  const flatMain = flattenedModules.find(m => m.name === mainName)!

  return right({
    ...typechecked,
    ...flattenedAnalysis,
    mainModule: flatMain,
    table: flattenedTable,
    stage: 'compiling',
  })
}

/** output a compiled spec in the format specified in the `compiled.args.target` to stdout
 *
 * @param compiled The result of a preceding compile stage
 */
export async function outputCompilationTarget(compiled: CompiledStage): Promise<CLIProcedure<CompiledStage>> {
  const stage: stage = 'outputting target'
  const args = compiled.args
  const verbosityLevel = deriveVerbosity(args)

  const parsedSpecJson = jsonStringOfOutputStage(
    pickOutputStage({ ...compiled, modules: [compiled.mainModule], table: compiled.table })
  )
  switch ((compiled.args.target as string).toLowerCase()) {
    case 'json':
      process.stdout.write(parsedSpecJson)
      return right(compiled)
    case 'tlaplus': {
      const toTlaResult = await compileToTlaplus(
        args.serverEndpoint,
        args.apalacheVersion,
        parsedSpecJson,
        verbosityLevel
      )
      return toTlaResult
        .mapRight(tla => {
          process.stdout.write(tla) // Write out, since all went right
          return compiled
        })
        .mapLeft(err => {
          return {
            msg: err.explanation,
            stage: { ...compiled, stage, status: 'error', errors: err.errors },
          }
        })
    }
    default:
      // This is validated in the arg parsing
      fail(`Invalid option for --target`)
  }
}

/**
 * Verify a spec via Apalache.
 *
 * @param prev the procedure stage produced by `typecheck`
 */
export async function verifySpec(prev: CompiledStage): Promise<CLIProcedure<TracingStage>> {
  const verifying = { ...prev, stage: 'verifying' as stage }
  const args = verifying.args
  // Force disable output if `--out-itf` is set
  const verbosityLevel = prev.args.outItf ? 0 : deriveVerbosity(prev.args)

  const itfFile: string | undefined = prev.args.outItf
  if (itfFile) {
    if (itfFile.includes(PLACEHOLDERS.test) || itfFile.includes(PLACEHOLDERS.seq)) {
      console.log(
        `${chalk.yellow('[warning]')} the output file contains ${chalk.grey(PLACEHOLDERS.test)} or ${chalk.grey(
          PLACEHOLDERS.seq
        )}, but this has no effect since at most a single trace will be produced.`
      )
    }
  }

  let loadedConfig: any = {}
  try {
    if (args.apalacheConfig) {
      loadedConfig = JSON.parse(readFileSync(args.apalacheConfig, 'utf-8'))
    }
  } catch (err: any) {
    return cliErr(`failed to read Apalache config: ${err.message}`, { ...verifying, errors: [], sourceCode: new Map() })
  }

  const veryfiyingFlat = { ...prev, modules: [prev.mainModule] }
  const parsedSpec = jsonStringOfOutputStage(pickOutputStage(veryfiyingFlat))

  // We need to insert the data form CLI args into their appropriate locations
  // in the Apalache config
  const config = {
    ...loadedConfig,
    input: {
      ...(loadedConfig.input ?? {}),
      source: {
        type: 'string',
        format: 'qnt',
        content: parsedSpec,
      },
    },
    checker: {
      ...(loadedConfig.checker ?? {}),
      length: args.maxSteps,
      init: 'q::init',
      next: 'q::step',
      inv: args.invariant ? ['q::inv'] : undefined,
      'temporal-props': args.temporal ? ['q::temporalProps'] : undefined,
      tuning: {
        ...(loadedConfig.checker?.tuning ?? {}),
        'search.simulation': args.randomTransitions ? 'true' : 'false',
      },
    },
  }

  const startMs = Date.now()

  return verify(args.serverEndpoint, args.apalacheVersion, config, verbosityLevel).then(res => {
    const elapsedMs = Date.now() - startMs
    return res
      .map(_ => {
        if (verbosity.hasResults(verbosityLevel)) {
          console.log(chalk.green('[ok]') + ' No violation found ' + chalk.gray(`(${elapsedMs}ms).`))
          if (verbosity.hasHints(verbosityLevel)) {
            console.log(chalk.gray('You may increase --max-steps.'))
            console.log(chalk.gray('Use --verbosity to produce more (or less) output.'))
          }
        }
        return { ...verifying, status: 'ok', errors: [] } as TracingStage
      })
      .mapLeft(err => {
        const trace: QuintEx[] | undefined = err.traces ? ofItf(err.traces[0]) : undefined
        const status = trace !== undefined ? 'violation' : 'failure'
        if (trace !== undefined) {
          // Always print the conterexample, unless the output is being directed to one of the outfiles
          maybePrintCounterExample(verbosityLevel, trace)

          if (verbosity.hasResults(verbosityLevel)) {
            console.log(chalk.red(`[${status}]`) + ' Found an issue ' + chalk.gray(`(${elapsedMs}ms).`))
          }

          if (prev.args.outItf && err.traces) {
            writeToJson(prev.args.outItf, err.traces[0])
          }
        }
        return {
          msg: err.explanation,
          stage: { ...verifying, status, errors: err.errors, trace },
        }
      })
  })
}

/**
 * Produces documentation from docstrings in a Quint specification.
 *
 * @param loaded the procedure stage produced by `load`
 */
export async function docs(loaded: LoadedStage): Promise<CLIProcedure<DocumentationStage>> {
  const { sourceCode, path } = loaded
  const text = sourceCode.get(path)!
  const parsing = { ...loaded, stage: 'documentation' as stage }
  const phase1Data = parsePhase1fromText(newIdGenerator(), text, path)
  const allEntries: [string, Map<string, DocumentationEntry>][] = phase1Data.modules.map(module => {
    const documentationEntries = produceDocs(module)
    const title = `# Documentation for ${module.name}\n\n`
    const markdown = title + [...documentationEntries.values()].map(toMarkdown).join('\n\n')
    console.log(markdown)

    return [module.name, documentationEntries]
  })

  if (phase1Data.errors.length > 0) {
    const newErrorMessages = phase1Data.errors.map(mkErrorMessage(phase1Data.sourceMap))
    const errorMessages = parsing.errors ? parsing.errors.concat(newErrorMessages) : newErrorMessages
    return left({ msg: 'parsing failed', stage: { ...parsing, errors: errorMessages } })
  }

  return right({ ...parsing, documentation: new Map(allEntries) })
}

/** Write the OutputStage of the procedureStage as JSON, if --out is set
 * Otherwise, report any stage errors to STDOUT
 */
export function outputResult(result: CLIProcedure<ProcedureStage>) {
  result
    .map(stage => {
      const verbosityLevel = deriveVerbosity(stage.args)
      const outputData = pickOutputStage(stage)
      if (stage.args.out) {
        writeToJson(stage.args.out, outputData)
      } else if (!stage.args.outItf && outputData.seed && verbosity.hasResults(verbosityLevel)) {
        console.log(chalk.gray(`Use --seed=0x${outputData.seed.toString(16)} to reproduce.`))
      }

      process.exit(0)
    })
    .mapLeft(({ msg, stage }) => {
      const { args, errors, sourceCode } = stage
      const verbosityLevel = deriveVerbosity(args)
      const outputData = pickOutputStage(stage)
      if (args.out) {
        writeToJson(args.out, outputData)
      } else {
        const finders = createFinders(sourceCode!)
        uniqWith(errors, isEqual).forEach(err => console.error(formatError(sourceCode, finders, err)))
        if (!stage.args.outItf && outputData.seed && verbosity.hasResults(verbosityLevel)) {
          console.log(chalk.gray(`Use --seed=0x${outputData.seed.toString(16)} to reproduce.`))
        }
        console.error(`error: ${msg}`)
      }
      process.exit(1)
    })
}

function guessMainModule(stage: TypecheckedStage): string {
  if (stage.args.main) {
    // the main module is specified via --main
    return stage.args.main
  }
  if (stage.defaultModuleName.isJust()) {
    // there is only one module in the source file, make it main
    return stage.defaultModuleName.unwrap()
  }
  // guess the name from the filename
  return basename(stage.args.input, '.qnt')
}

/**
 * Produce a random-number generator: Either a predictable one using a seed,
 * or a reasonably unpredictable one.
 */
function mkRng(seedText?: string): Either<string, Rng> {
  let seed
  if (seedText !== undefined) {
    // since yargs does not has a type for big integers,
    // we do it with a fallback
    try {
      seed = BigInt(seedText)
    } catch (SyntaxError) {
      return left(`--seed must be a big integer, found: ${seedText}`)
    }
  }

  return right(seed ? newRng(seed) : newRng())
}

function addItfHeader(source: string, status: string, traceInJson: any): any {
  return {
    '#meta': {
      format: 'ITF',
      'format-description': 'https://apalache.informal.systems/docs/adr/015adr-trace.html',
      source,
      status,
      description: 'Created by Quint on ' + new Date(),
      timestamp: Date.now(),
    },
    ...traceInJson,
  }
}

// Preprocess troublesome types so they are represented in JSON.
//
// We need it particularly because, by default, serialization of Map and Set
// objects just produces an empty object
// (see https://stackoverflow.com/questions/46634449/json-stringify-of-object-of-map-return-empty)
//
// The approach here follows https://stackoverflow.com/a/56150320/1187277
function replacer(_key: String, value: any): any {
  if (value instanceof Map) {
    // Represent Maps as JSON objects
    return Object.fromEntries(value)
  } else if (value instanceof Set) {
    // Represent Sets as JSON arrays
    return Array.from(value)
  } else {
    return value
  }
}

function jsonStringOfOutputStage(json: any): string {
  return JSONbig.stringify(json, replacer)
}

/**
 * Write json to a file.
 *
 * @param filename name of the file to write to
 * @param json is an object tree to write
 */
function writeToJson(filename: string, json: any) {
  const path = resolve(cwd(), filename)
  writeFileSync(path, jsonStringOfOutputStage(json))
}

/**
 * Does a definition name match the expected test criteria.
 *
 * @param tests an optional array of test names
 * @param name the name of a definition to match
 * @returns whether the name matches the tests, if tests are not undefined,
 *          or name ends with 'Test'
 *
 */
function isMatchingTest(match: string | undefined, name: string) {
  if (match) {
    return new RegExp(match).exec(name) !== null
  } else {
    return name.endsWith('Test')
  }
}

// Derive the verbosity for simulation and verification routines
function deriveVerbosity(args: { out: string | undefined; verbosity: number }): number {
  return args.out ? 0 : args.verbosity
}

const PLACEHOLDERS = {
  test: '{test}',
  seq: '{seq}',
}

/**
 * Expand the output template with the name of the test and the index of the trace.
 *
 * Possible placeholders:
 * - {test} is replaced with the name of the test
 * - {seq} is replaced with the index of the trace
 *
 * If {seq} is not present and `options.autoAppend` is true,
 * the index is appended to the filename, before the extension.
 *
 * @param template the output template
 * @param name the name of the test
 * @param index the index of the trace
 * @param options An object of the form `{ autoAppend: boolean }`
 * @returns the expanded output template
 */
function expandNamedOutputTemplate(
  template: string,
  name: string,
  index: number,
  options: { autoAppend: boolean }
): string {
  return expandOutputTemplate(template.replaceAll(PLACEHOLDERS.test, name), index, options)
}

/**
 * Expand the output template with the index of the trace.
 *
 * The {seq} placeholder is replaced with the index of the trace.
 *
 * If {seq} is not present and `options.autoAppend` is true,
 * the index is appended to the filename, before the extension.
 *
 * @param template the output template
 * @param index the index of the trace
 * @param options An object of the form `{ autoAppend: boolean }`
 * @returns the expanded output template
 */
function expandOutputTemplate(template: string, index: number, options: { autoAppend: boolean }): string {
  if (template.includes(PLACEHOLDERS.seq)) {
    return template.replaceAll(PLACEHOLDERS.seq, index.toString())
  }

  if (options.autoAppend) {
    const parts = template.split('.')
    parts[0] += `${index}`
    return parts.join('.')
  }

  return template
}
