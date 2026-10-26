#!/usr/bin/env python3
"""Compare the native variable pass against the pinned original C, never linked.

The fixtures construct parser IR directly: every scope opcode, local/argument/
closure/global lookup, const/TDZ/function-name semantics, private accessors,
with/eval environments, reference rewrite permutations, and dead-code peepholes.
Metadata and atom balance are observable records, not implementation assertions.
Run explicitly; this file does not run checks when imported.
"""
import argparse
import hashlib
from pathlib import Path
import shutil
import tempfile
import tomllib
from verify_bytecode import validate_pins, executable_path, SUPPORT
from verify_compiler_state import execute, SILK_SOURCE as STATE_SOURCE
import toolchain

ROOT = Path(__file__).resolve().parents[1]
OPS = ['scope_get_var_undef', 'scope_get_var', 'scope_put_var', 'scope_delete_var',
       'scope_get_ref', 'scope_put_var_init', 'scope_make_ref']


def fixtures():
    """Each pair sets up the same IR, then calls the independent production pass."""
    cases = []
    for storage in ('local', 'argument', 'closure', 'global', 'with', 'evalobject', 'evalclosure'):
        for lexical, constant, function_name in ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 0, 1)):
            if storage in ('argument', 'global', 'with', 'evalobject', 'evalclosure') and (lexical or constant or function_name):
                continue
            for operation in OPS:
                for permutation in (('insert3', 'perm4', 'rot3l', 'nop', 'swap') if operation == 'scope_make_ref' else ('nop',)):
                    c, s = [], []
                    owner_c, owner_s = ('root', 'root') if storage == 'closure' else ('fd', 'cell')
                    if storage == 'closure':
                        c += ['fd=js_new_function_def(ctx,root,FALSE,FALSE,"probe",source,&cache);']
                        s += ['cell=run unsafe state.newFunction(context,root,false,false,0,0,Pointer.null<SourcePositionCache>())']
                    if storage in ('local', 'closure', 'argument'):
                        c += [f'int v={"add_arg" if storage == "argument" else "add_var"}(ctx,{owner_c},JS_ATOM_name);',
                              f'{owner_c}->{"args" if storage == "argument" else "vars"}[v].is_lexical={lexical};',
                              f'{owner_c}->{"args" if storage == "argument" else "vars"}[v].is_const={constant};',
                              f'{owner_c}->{"args" if storage == "argument" else "vars"}[v].var_kind={"JS_VAR_FUNCTION_NAME" if function_name else "JS_VAR_NORMAL"};']
                        s += [f'let owner=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,{owner_s})',
                              'let runtimeState=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)',
                              f'let v=run state.{"addArg" if storage == "argument" else "addVar"}(&mut owner,&mut runtimeState.atoms,atoms.JS_ATOM_name)',
                              f'let mut variable=owner.{"args" if storage == "argument" else "vars"}.get(i32.toUsize(v))',
                              f'variable.isLexical={str(bool(lexical)).lower()} variable.isConst={str(bool(constant)).lower()} variable.kind=VariableKind.{"FunctionName" if function_name else "Normal"}',
                              f'owner.{"args" if storage == "argument" else "vars"}.set(i32.toUsize(v),variable)', 'drop runtimeState drop owner']
                    elif storage in ('with', 'evalobject'):
                        atom = '_with_' if storage == 'with' else '_var_'
                        c += [f'int v=add_var(ctx,fd,JS_ATOM_{atom});']
                        if storage == 'evalobject': c += ['fd->var_object_idx=v;']
                        s += ['let owner=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell)', 'let runtimeState=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)',
                              f'let v=run state.addVar(&mut owner,&mut runtimeState.atoms,atoms.JS_ATOM_{atom})']
                        if storage == 'evalobject': s += ['owner.varObjectIndex=v']
                        s += ['drop runtimeState drop owner']
                    elif storage == 'evalclosure':
                        c += ['add_closure_var(ctx,fd,JS_CLOSURE_REF,0,JS_ATOM__with_,FALSE,FALSE,JS_VAR_NORMAL);']
                        s += ['let owner=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell)', 'let runtimeState=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)',
                              'let v=run state.addClosureVar(&mut owner,&mut runtimeState.atoms,ClosureKind.Reference,0,atoms.JS_ATOM__with_,false,false,VariableKind.Normal)', 'drop runtimeState drop owner']
                    c += ['links(root); if(fd!=root) links(fd);', 'JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd;']
                    s += ['let rootFd=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,root) variables.recomputeScopeLinks(&mut rootFd) drop rootFd',
                          'let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) variables.recomputeScopeLinks(&mut target)',
                          'let atomTable=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)']
                    if operation == 'scope_make_ref':
                        c += ['int label=new_label_fd(fd); update_label(fd,label,1);', f'emit_op(&ps,OP_{operation}); emit_atom(&ps,JS_ATOM_name); emit_u32(&ps,label); emit_u16(&ps,0);',
                              'emit_op(&ps,OP_get_ref_value); emit_label_raw(&ps,label);', f'emit_op(&ps,OP_{permutation}); emit_op(&ps,OP_put_ref_value);']
                        s += ['let label=run emit.newLabelFd(&mut target) let references=emit.updateLabel(&mut target,label,1)',
                              f'run emit.emitOp(&mut target,op.OP_{operation}) run emit.emitAtom(&mut target,&mut atomTable.atoms,atoms.JS_ATOM_name) run emit.emitU32(&mut target,i32.toU32(label)) run emit.emitU16(&mut target,0)',
                              'run emit.emitOp(&mut target,op.OP_get_ref_value) run emit.emitLabelRaw(&mut target,label)', f'run emit.emitOp(&mut target,op.OP_{permutation}) run emit.emitOp(&mut target,op.OP_put_ref_value)']
                    else:
                        c += [f'emit_op(&ps,OP_{operation}); emit_atom(&ps,JS_ATOM_name); emit_u16(&ps,0);']
                        s += [f'run emit.emitOp(&mut target,op.OP_{operation}) run emit.emitAtom(&mut target,&mut atomTable.atoms,atoms.JS_ATOM_name) run emit.emitU16(&mut target,0)']
                    s += ['drop atomTable drop target']
                    cases.append((f'{storage}/{lexical}/{constant}/{function_name}/{operation}/{permutation}', '\n'.join(c), '\n'.join(s)))
    # Private-field branches include the second getter result, setter lookup, and
    # a missing-name diagnostic. Setter names use the real atom concatenation API.
    for kind, ckind in [('PrivateField','PRIVATE_FIELD'), ('PrivateMethod','PRIVATE_METHOD'), ('PrivateGetter','PRIVATE_GETTER'), ('PrivateSetter','PRIVATE_SETTER'), ('PrivateGetterSetter','PRIVATE_GETTER_SETTER')]:
        for operation in ('scope_get_private_field', 'scope_get_private_field2', 'scope_put_private_field', 'scope_in_private_field'):
            c = f'''int v=add_var(ctx,fd,JS_ATOM_name); fd->vars[v].var_kind=JS_VAR_{ckind};
JSAtom setter=get_private_setter_name(ctx,JS_ATOM_name); int sv=add_var(ctx,fd,setter); JS_FreeAtom(ctx,setter); fd->vars[sv].var_kind=JS_VAR_PRIVATE_SETTER;
links(fd); JSParseState ps={{0}}; ps.ctx=ctx; ps.cur_func=fd;
emit_op(&ps,OP_{operation}); emit_atom(&ps,JS_ATOM_name); emit_u16(&ps,0);'''
            s = f'''let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell)
let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
let v=run state.addVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_name)
let mut value=target.vars.get(i32.toUsize(v)) value.kind=VariableKind.{kind} target.vars.set(i32.toUsize(v),value)
let setter=run rt.atoms.concatUtf8(atoms.JS_ATOM_name,b"<set>")
let sv=run state.addVar(&mut target,&mut rt.atoms,setter) rt.atoms.release(setter)
let mut setterVar=target.vars.get(i32.toUsize(sv)) setterVar.kind=VariableKind.PrivateSetter target.vars.set(i32.toUsize(sv),setterVar)
variables.recomputeScopeLinks(&mut target)
run emit.emitOp(&mut target,op.OP_{operation}) run emit.emitAtom(&mut target,&mut rt.atoms,atoms.JS_ATOM_name) run emit.emitU16(&mut target,0)
drop rt drop target'''
            cases.append((f'private/{kind}/{operation}', c, s))
    c = 'JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd; emit_op(&ps,OP_scope_get_private_field); emit_atom(&ps,JS_ATOM_name); emit_u16(&ps,0);'
    s = 'let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime) run emit.emitOp(&mut target,op.OP_scope_get_private_field) run emit.emitAtom(&mut target,&mut rt.atoms,atoms.JS_ATOM_name) run emit.emitU16(&mut target,0) drop rt drop target'
    cases.append(('private/missing', c, s))
    cases.extend(preparation_fixtures())
    cases.extend(peephole_fixtures())
    cases.extend(module_fixtures())
    cases.extend(snapshot_fixtures())
    cases.extend(ancestry_fixtures(cases))
    cases.extend(scope_fixtures())
    return cases


def ancestry_fixtures(base):
    cases = []
    for name, c, s in base:
        if name.startswith('closure/'):
            c = c.replace('fd=js_new_function_def(ctx,root,FALSE,FALSE,"probe",source,&cache);',
                          'JSFunctionDef *middle=js_new_function_def(ctx,root,FALSE,FALSE,"probe",source,&cache); fd=js_new_function_def(ctx,middle,FALSE,FALSE,"probe",source,&cache);')
            s = s.replace('cell=run unsafe state.newFunction(context,root,false,false,0,0,Pointer.null<SourcePositionCache>())',
                          'let middle=run unsafe state.newFunction(context,root,false,false,0,0,Pointer.null<SourcePositionCache>()) cell=run unsafe state.newFunction(context,middle,false,false,0,0,Pointer.null<SourcePositionCache>())')
            c += '\n// CLEANUP\ndump(middle);'
            s += '\n// CLEANUP\nlet middleView=unsafe HeapCell.payload<FunctionDef,()>(&a,middle) run dump(&mut out,&middleView.*) drop middleView'
            cases.append(('transitive/' + name, c, s))
        elif name.startswith('private/Private') or name.startswith('pseudo/'):
            c = c.replace('JSParseState ps=', 'fd=js_new_function_def(ctx,root,FALSE,FALSE,"probe",source,&cache); JSParseState ps=')
            prefix, marker, suffix = s.partition('run emit.emitOp')
            if not marker:
                raise ValueError(name)
            s = (prefix + 'drop rt drop target\ncell=run unsafe state.newFunction(context,root,false,false,0,0,Pointer.null<SourcePositionCache>())\n'
                 'let childTarget=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let childRuntime=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)\n'
                 + (marker + suffix).replace('&mut target', '&mut childTarget').replace('drop target', 'drop childTarget').replace('&mut rt.atoms', '&mut childRuntime.atoms').replace('drop rt', 'drop childRuntime'))
            cases.append(('ancestor/' + name, c, s))
    return cases


def scope_fixtures():
    c = '''JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd;
int a=add_arg(ctx,fd,JS_ATOM_name); fd->args[a].func_pool_idx=2;
int local=add_var(ctx,fd,JS_ATOM_value); fd->vars[local].func_pool_idx=3;
push_scope(&ps); fd->body_scope=push_scope(&ps);
int f=add_scope_var(ctx,fd,JS_ATOM_length,JS_VAR_FUNCTION_DECL); fd->vars[f].func_pool_idx=4;
int g=add_scope_var(ctx,fd,JS_ATOM_done,JS_VAR_NEW_FUNCTION_DECL); fd->vars[g].func_pool_idx=5;
int x=add_scope_var(ctx,fd,JS_ATOM_this,JS_VAR_NORMAL); fd->vars[x].is_lexical=1; capture_var(fd,&fd->vars[x]);
emit_op(&ps,OP_scope_get_var_checkthis); emit_atom(&ps,JS_ATOM_this); emit_u16(&ps,fd->scope_level);
emit_op(&ps,OP_scope_put_var_init); emit_atom(&ps,JS_ATOM_this); emit_u16(&ps,fd->scope_level);
emit_op(&ps,OP_leave_scope); emit_u16(&ps,fd->scope_level); links(fd);'''
    s = '''let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
let arg=run state.addArg(&mut target,&mut rt.atoms,atoms.JS_ATOM_name) let mut argVar=target.args.get(i32.toUsize(arg)) argVar.functionPoolIndex=2 target.args.set(i32.toUsize(arg),argVar)
let local=run state.addVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_value) let mut localVar=target.vars.get(i32.toUsize(local)) localVar.functionPoolIndex=3 target.vars.set(i32.toUsize(local),localVar)
let first=run emit.pushScope(&mut target) let body=run emit.pushScope(&mut target) target.bodyScope=body
let f=run state.addScopeVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_length,VariableKind.FunctionDeclaration) let mut fv=target.vars.get(i32.toUsize(f)) fv.functionPoolIndex=4 target.vars.set(i32.toUsize(f),fv)
let g=run state.addScopeVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_done,VariableKind.NewFunctionDeclaration) let mut gv=target.vars.get(i32.toUsize(g)) gv.functionPoolIndex=5 target.vars.set(i32.toUsize(g),gv)
let x=run state.addScopeVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_this,VariableKind.Normal) let mut xv=target.vars.get(i32.toUsize(x)) xv.isLexical=true target.vars.set(i32.toUsize(x),xv) state.captureVar(&mut target,x,false)
run emit.emitOp(&mut target,op.OP_scope_get_var_checkthis) run emit.emitAtom(&mut target,&mut rt.atoms,atoms.JS_ATOM_this) run emit.emitU16(&mut target,i32.toU16(body))
run emit.emitOp(&mut target,op.OP_scope_put_var_init) run emit.emitAtom(&mut target,&mut rt.atoms,atoms.JS_ATOM_this) run emit.emitU16(&mut target,i32.toU16(body))
run emit.emitOp(&mut target,op.OP_leave_scope) run emit.emitU16(&mut target,i32.toU16(body)) variables.recomputeScopeLinks(&mut target) drop rt drop target'''
    cases = [('scope/hoisted-captured-derived-this', c, s)]
    for ancestor in (False, True):
        c = '''JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd;
fd->has_parameter_expressions=1; add_var(ctx,fd,JS_ATOM_name); push_scope(&ps); links(fd);
'''
        s = '''let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
target.hasParameterExpressions=true let hidden=run state.addVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_name) let argumentScope=run emit.pushScope(&mut target) variables.recomputeScopeLinks(&mut target) drop rt drop target
'''
        scope = 1
        if ancestor:
            c += 'fd=js_new_function_def(ctx,root,FALSE,FALSE,"probe",source,&cache); ps.cur_func=fd;\n'
            s += 'cell=run unsafe state.newFunction(context,root,false,false,0,0,Pointer.null<SourcePositionCache>())\n'
            scope = 0
        c += f'emit_op(&ps,OP_scope_get_var); emit_atom(&ps,JS_ATOM_name); emit_u16(&ps,{scope});'
        s += f'''let prepared=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let table=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
run emit.emitOp(&mut prepared,op.OP_scope_get_var) run emit.emitAtom(&mut prepared,&mut table.atoms,atoms.JS_ATOM_name) run emit.emitU16(&mut prepared,{scope}) drop table drop prepared'''
        cases.append((f'scope/argument-isolation/ancestor={ancestor}', c, s))
    return cases


def module_fixtures():
    cases = []
    for mode in ('local', 'import', 'namespace', 'missing', 'function'):
        c = ['JSModuleDef module={0}; JSExportEntry entry={0}; JSImportEntry imported={0};',
             'fd->module=&module; module.export_entries=&entry; module.export_entries_count=1;',
             'entry.export_type=JS_EXPORT_TYPE_LOCAL; entry.local_name=JS_DupAtom(ctx,JS_ATOM_name); entry.export_name=JS_DupAtom(ctx,JS_ATOM_name);']
        s = ['let moduleCell=run makeModule() let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) target.module=moduleCell',
             'let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime) let mut ma=() let module=unsafe HeapCell.payloadMut<ModuleDef,()>(&mut ma,moduleCell)',
             'run module.exports.append(ExportEntry { binding:ExportBinding.Local { variableIndex:0,varRef:Pointer.null<HeapHeader>() },localName:rt.atoms.duplicate(atoms.JS_ATOM_name),exportName:rt.atoms.duplicate(atoms.JS_ATOM_name) })']
        if mode in ('local', 'function'):
            c += ['JSGlobalVar *global=add_global_var(ctx,fd,JS_ATOM_name);']
            s += ['let global=run state.addGlobalVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_name)']
            if mode == 'function':
                c += ['global->cpool_idx=7;']
                s += ['let mut g=target.globalVars.get(i32.toUsize(global)) g.constantPoolIndex=7 target.globalVars.set(i32.toUsize(global),g)']
        if mode in ('import', 'namespace'):
            c += ['add_closure_var(ctx,fd,JS_CLOSURE_MODULE_IMPORT,0,JS_ATOM_name,TRUE,TRUE,JS_VAR_NORMAL);',
                  'module.import_entries=&imported; module.import_entries_count=1; imported.var_idx=0; imported.req_module_idx=3; imported.import_name=JS_DupAtom(ctx,JS_ATOM_value);',
                  f'imported.is_star={int(mode == "namespace")};']
            s += ['let imported=run state.addClosureVar(&mut target,&mut rt.atoms,ClosureKind.ModuleImport,0,atoms.JS_ATOM_name,true,true,VariableKind.Normal)',
                  f'run module.imports.append(ImportEntry {{ variableIndex:0,isStar:{str(mode == "namespace").lower()},importName:rt.atoms.duplicate(atoms.JS_ATOM_value),requestedModuleIndex:3 }})']
        c += ['int prepare=add_global_variables(ctx,fd); word(prepare); if(prepare<0) { JSValue e=JS_GetException(ctx); JS_FreeValue(ctx,e); }',
              'word(entry.export_type); word(entry.export_type==JS_EXPORT_TYPE_LOCAL ? entry.u.local.var_idx : entry.u.req_module_idx); word(entry.local_name);',
              'JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd; fd->body_scope=push_scope(&ps); links(fd);',
              '// CLEANUP', 'JS_FreeAtom(ctx,entry.local_name); JS_FreeAtom(ctx,entry.export_name); JS_FreeAtom(ctx,imported.import_name); fd->module=NULL;']
        s += ['drop module drop rt drop target',
              'let prepare=run prepareGlobal(cell) |> Effect.catch<CompilerError>(missingExport) run word(&mut out,prepare)',
              'let moduleView=unsafe HeapCell.payload<ModuleDef,()>(&ma,moduleCell) let entry=moduleView.exports.get(0)',
              'match entry.binding { ExportBinding.Local { variableIndex,.. } => { run word(&mut out,0) run word(&mut out,variableIndex) } ExportBinding.Indirect { requestedModuleIndex } => { run word(&mut out,1) run word(&mut out,requestedModuleIndex) } }',
              'run word(&mut out,u32.toI32(entry.localName)) drop moduleView',
              'let prepared=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let body=run emit.pushScope(&mut prepared) prepared.bodyScope=body variables.recomputeScopeLinks(&mut prepared) drop prepared',
              '// CLEANUP',
              'let cleanModule=unsafe HeapCell.payload<ModuleDef,()>(&ma,moduleCell) let cleanRuntime=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)',
              'let exported=cleanModule.exports.get(0) cleanRuntime.atoms.release(exported.localName) cleanRuntime.atoms.release(exported.exportName)',
              'if cleanModule.imports.length()>0 { cleanRuntime.atoms.release(cleanModule.imports.get(0).importName) } drop cleanRuntime drop cleanModule',
              'let detached=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) detached.module=Pointer.null<HeapHeader>() drop detached unsafe HeapCell.destroy<ModuleDef>(moduleCell)']
        cases.append((f'module/{mode}', '\n'.join(c), '\n'.join(s)))
    return cases


def snapshot_fixtures():
    cases = []
    for arg_scope in (False, True):
        c = ['JSFunctionBytecode b={0}; JSBytecodeVarDef definitions[5]={0}; JSClosureVar closures[8]={0};',
             'b.arg_count=1; b.var_count=4; b.closure_var_count=8; b.vardefs=definitions; b.closure_var=closures;',
             'definitions[0].var_name=JS_ATOM_name; definitions[1].var_name=JS_ATOM_length;',
             'definitions[2].var_name=JS_ATOM_this; definitions[3].var_name=JS_ATOM__ret_; definitions[4].var_name=JS_ATOM_value;',
             f'definitions[4].has_scope=1; definitions[4].is_lexical=1; definitions[4].is_const=1; definitions[4].scope_next={-2 if arg_scope else -1};',
             'for(int i=0;i<8;i++) { closures[i].closure_type=i; closures[i].var_name=JS_ATOM_done; closures[i].is_lexical=i&1; closures[i].is_const=i&1; }',
             'word(add_closure_variables(ctx,fd,&b,3));']
        s = ['let mut snapshot=makeSnapshot(context)',
             'run snapshot.varDefs.append(snapshotVar(atoms.JS_ATOM_name,false,-1))',
             'run snapshot.varDefs.append(snapshotVar(atoms.JS_ATOM_length,false,-1))',
             'run snapshot.varDefs.append(snapshotVar(atoms.JS_ATOM_this,false,-1))',
             'run snapshot.varDefs.append(snapshotVar(atoms.JS_ATOM__ret_,false,-1))',
             f'run snapshot.varDefs.append(snapshotVar(atoms.JS_ATOM_value,true,{-2 if arg_scope else -1}))']
        kinds = ['Local', 'Argument', 'Reference', 'GlobalReference', 'GlobalDeclaration', 'Global', 'ModuleDeclaration', 'ModuleImport']
        for i, kind in enumerate(kinds):
            s += [f'run snapshot.closureVars.append(ClosureVar {{ kind:ClosureKind.{kind},variableIndex:0,name:atoms.JS_ATOM_done,isConst:{str(bool(i & 1)).lower()},isLexical:{str(bool(i & 1)).lower()},variableKind:VariableKind.Normal }})']
        s += ['let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)',
              'run variables.addClosureVariables(&mut target,&mut rt.atoms,&snapshot,3) run word(&mut out,0) drop rt drop target']
        cases.append((f'eval-snapshot/argument-scope={arg_scope}', '\n'.join(c), '\n'.join(s)))
    return cases


def preparation_fixtures():
    cases = []
    for strict in (False, True):
        for parameters in (False, True):
            for nested in (False, True):
                c = ['fd->has_this_binding=1; fd->has_arguments_binding=1; fd->has_home_object=1; fd->is_derived_class_constructor=1;',
                     f'fd->js_mode={int(strict)}; fd->has_parameter_expressions={int(parameters)};',
                     'fd->is_func_expr=1; fd->func_name=JS_DupAtom(ctx,JS_ATOM_length);',
                     'add_arg(ctx,fd,JS_ATOM_name); add_var(ctx,fd,JS_ATOM_value); add_var(ctx,fd,JS_ATOM__ret_);',
                     'JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd; push_scope(&ps); push_scope(&ps);',
                     'int lexical=add_scope_var(ctx,fd,JS_ATOM_done,JS_VAR_NORMAL); fd->vars[lexical].is_lexical=1;',
                     'links(root);']
                s = ['let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)',
                     'target.hasThisBinding=true target.hasArgumentsBinding=true target.hasHomeObject=true target.isDerivedClassConstructor=true',
                     f'target.jsMode={int(strict)} target.hasParameterExpressions={str(parameters).lower()}',
                     'target.isFuncExpr=true target.functionName=rt.atoms.duplicate(atoms.JS_ATOM_length)',
                     'let arg=run state.addArg(&mut target,&mut rt.atoms,atoms.JS_ATOM_name) let local=run state.addVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_value) let ret=run state.addVar(&mut target,&mut rt.atoms,atoms.JS_ATOM__ret_)',
                     'let argumentScope=run emit.pushScope(&mut target) let body=run emit.pushScope(&mut target)',
                     'let lexical=run state.addScopeVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_done,VariableKind.Normal) let mut lexicalVar=target.vars.get(i32.toUsize(lexical)) lexicalVar.isLexical=true target.vars.set(i32.toUsize(lexical),lexicalVar)',
                     'variables.recomputeScopeLinks(&mut target) drop rt drop target']
                if nested:
                    c += ['fd=js_new_function_def(ctx,root,FALSE,FALSE,"probe",source,&cache); ps.cur_func=fd; links(fd);']
                    s += ['cell=run unsafe state.newFunction(context,root,false,false,0,0,Pointer.null<SourcePositionCache>())']
                c += ['add_eval_variables(ctx,fd);', 'emit_op(&ps,OP_eval); emit_u16(&ps,2); emit_u16(&ps,0); emit_op(&ps,OP_apply_eval); emit_u16(&ps,0);']
                s += ['run unsafe variables.addEvalVariables(cell)',
                      'let prepared=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) run emit.emitOp(&mut prepared,op.OP_eval) run emit.emitU16(&mut prepared,2) run emit.emitU16(&mut prepared,0) run emit.emitOp(&mut prepared,op.OP_apply_eval) run emit.emitU16(&mut prepared,0) drop prepared']
                cases.append((f'eval/strict={strict}/parameters={parameters}/nested={nested}', '\n'.join(c), '\n'.join(s)))
    for name in ('this', 'new_target', 'home_object', 'this_active_func', 'arguments', 'length'):
        for strict in (False, True):
            for derived in (False, True):
                c = f'''fd->has_this_binding=1; fd->has_arguments_binding=1; fd->is_derived_class_constructor={int(derived)}; fd->js_mode={int(strict)};
fd->is_func_expr=1; fd->func_name=JS_DupAtom(ctx,JS_ATOM_length);
JSParseState ps={{0}}; ps.ctx=ctx; ps.cur_func=fd;
emit_op(&ps,OP_scope_get_var); emit_atom(&ps,JS_ATOM_{name}); emit_u16(&ps,0);
emit_op(&ps,OP_scope_put_var_init); emit_atom(&ps,JS_ATOM_{name}); emit_u16(&ps,0);'''
                s = f'''let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
target.hasThisBinding=true target.hasArgumentsBinding=true target.isDerivedClassConstructor={str(derived).lower()} target.jsMode={int(strict)}
target.isFuncExpr=true target.functionName=rt.atoms.duplicate(atoms.JS_ATOM_length)
run emit.emitOp(&mut target,op.OP_scope_get_var) run emit.emitAtom(&mut target,&mut rt.atoms,atoms.JS_ATOM_{name}) run emit.emitU16(&mut target,0)
run emit.emitOp(&mut target,op.OP_scope_put_var_init) run emit.emitAtom(&mut target,&mut rt.atoms,atoms.JS_ATOM_{name}) run emit.emitU16(&mut target,0)
drop rt drop target'''
                cases.append((f'pseudo/{name}/{strict}/{derived}', c, s))
    for direct in (False, True):
        for environment in (False, True):
            for lexical in (False, True):
                c = f'''fd->eval_type={2 if direct else 0};
JSGlobalVar *global=add_global_var(ctx,fd,JS_ATOM_name); global->force_init=1;
global->is_lexical={int(lexical)}; global->is_const={int(lexical)};
'''
                s = f'''let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)
target.evalType={2 if direct else 0}
let global=run state.addGlobalVar(&mut target,&mut rt.atoms,atoms.JS_ATOM_name)
let mut globalVar=target.globalVars.get(i32.toUsize(global)) globalVar.forceInit=true globalVar.isLexical={str(lexical).lower()} globalVar.isConst={str(lexical).lower()} target.globalVars.set(i32.toUsize(global),globalVar)
'''
                if environment:
                    c += 'add_closure_var(ctx,fd,JS_CLOSURE_REF,0,JS_ATOM__var_,FALSE,FALSE,JS_VAR_NORMAL);\n'
                    s += 'let closure=run state.addClosureVar(&mut target,&mut rt.atoms,ClosureKind.Reference,0,atoms.JS_ATOM__var_,false,false,VariableKind.Normal)\n'
                c += 'add_global_variables(ctx,fd); JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd; fd->body_scope=push_scope(&ps); links(fd);'
                s += 'drop rt drop target run unsafe variables.addGlobalVariables(cell) let prepared=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let body=run emit.pushScope(&mut prepared) prepared.bodyScope=body variables.recomputeScopeLinks(&mut prepared) drop prepared'
                cases.append((f'global/direct={direct}/environment={environment}/lexical={lexical}', c, s))
    return cases


def peephole_fixtures():
    programs = [
        [('insert3',), ('put_array_el',), ('drop',)],
        [('insert3',), ('line_num', 37), ('put_ref_value',), ('line_num', 45), ('drop',)],
        [('return_undef',), ('scope_get_var', 'name', 0), ('line_num', 31), ('label', 0), ('return_undef',)],
        [('gosub', 0), ('return_undef',), ('label', 0), ('line_num', 19), ('ret',)],
        [('dup',), ('if_false', 0), ('drop',), ('label', 0), ('dup',), ('if_false', 1), ('drop',), ('label', 1), ('if_false', 2), ('label', 2), ('return_undef',)],
        [('dup',), ('if_true', 0), ('drop',), ('label', 0), ('if_true', 1), ('label', 1), ('return_undef',)],
        [('set_name', None), ('set_class_name', 17), ('get_field_opt_chain', 'name'), ('get_array_el_opt_chain',), ('nop',)],
        [('line_num', 0xffffffff), ('line_num', 0x80000000), ('drop',)],
    ]
    cases = []
    for number, program in enumerate(programs):
        labels = max((entry[1] for entry in program if entry[0] == 'label'), default=-1) + 1
        c = ['JSParseState ps={0}; ps.ctx=ctx; ps.cur_func=fd;', f'for(int i=0;i<{labels};i++) new_label_fd(fd);']
        s = ['let target=unsafe HeapCell.payloadMut<FunctionDef,()>(&mut a,cell) let rt=unsafe HeapCell.payloadMut<RuntimeState,()>(&mut r,runtime)']
        for i in range(labels):
            s += [f'let label{i}=run emit.newLabelFd(&mut target)']
        for entry in program:
            code, *operands = entry
            if code == 'label':
                c += [f'emit_label_raw(&ps,{operands[0]});']
                s += [f'run emit.emitLabelRaw(&mut target,{operands[0]})']
                continue
            c += [f'emit_op(&ps,OP_{code});']
            s += [f'run emit.emitOp(&mut target,op.OP_{code})']
            for operand in operands:
                if isinstance(operand, str) or operand is None:
                    atom_c = f'JS_ATOM_{operand}' if operand else 'JS_ATOM_NULL'
                    atom_s = f'atoms.JS_ATOM_{operand}' if operand else '0'
                    c += [f'emit_atom(&ps,{atom_c});']
                    s += [f'run emit.emitAtom(&mut target,&mut rt.atoms,{atom_s})']
                else:
                    width = 16 if code.startswith('scope_') else 32
                    c += [f'emit_u{width}(&ps,{operand}u);']
                    s += [f'run emit.emitU{width}(&mut target,{operand})']
            if code in ('gosub', 'goto', 'if_false', 'if_true', 'catch'):
                c += [f'update_label(fd,{operands[0]},1);']
                s += [f'let refs{len(s)}=emit.updateLabel(&mut target,{operands[0]},1)']
        s += ['drop rt drop target']
        cases.append((f'peephole/{number}', '\n'.join(c), '\n'.join(s)))
    return cases


C_HEADER = r'''
#include "quickjs.c"
static void word(uint32_t x) { for(int i=0;i<4;i++) putchar((x>>(8*i))&255); }
static void links(JSFunctionDef *fd) {
  for(int s=0;s<fd->scope_count;s++) fd->scopes[s].first=-1;
  if(fd->has_parameter_expressions) fd->scopes[ARG_SCOPE_INDEX].first=ARG_SCOPE_END;
  for(int i=0;i<fd->var_count;i++) { JSVarDef *v=&fd->vars[i]; v->scope_next=fd->scopes[v->scope_level].first; fd->scopes[v->scope_level].first=i; }
  for(int s=2;s<fd->scope_count;s++) if(fd->scopes[s].first<0) fd->scopes[s].first=fd->scopes[fd->scopes[s].parent].first;
  for(int i=0;i<fd->var_count;i++) { JSVarDef *v=&fd->vars[i]; if(v->scope_next<0 && v->scope_level>1) v->scope_next=fd->scopes[fd->scopes[v->scope_level].parent].first; }
}
static void dump(JSFunctionDef *fd) {
 word(fd->byte_code.size); for(size_t i=0;i<fd->byte_code.size;i++) word(fd->byte_code.buf[i]);
 word(fd->jump_size); word(fd->line_number_size); word(fd->var_ref_count);
 word(fd->var_count); for(int i=0;i<fd->var_count;i++) { JSVarDef *v=&fd->vars[i]; word(v->is_captured); word(v->var_ref_idx); word(v->scope_next); word(v->var_name<JS_ATOM_END ? v->var_name : -1); word(v->is_lexical); word(v->is_const); word(v->var_kind); }
 word(fd->arg_count); for(int i=0;i<fd->arg_count;i++) { word(fd->args[i].is_captured); word(fd->args[i].var_ref_idx); }
 word(fd->closure_var_count); for(int i=0;i<fd->closure_var_count;i++) { JSClosureVar *v=&fd->closure_var[i]; word(v->closure_type); word(v->var_idx); word(v->is_const); word(v->is_lexical); word(v->var_kind); word(v->var_name<JS_ATOM_END ? v->var_name : -1); }
 word(fd->scope_count); for(int i=0;i<fd->scope_count;i++) { word(fd->scopes[i].first); word(fd->scopes[i].parent); }
 word(fd->this_var_idx); word(fd->new_target_var_idx); word(fd->home_object_var_idx); word(fd->this_active_func_var_idx); word(fd->arguments_var_idx); word(fd->arguments_arg_idx); word(fd->func_var_idx); word(fd->var_object_idx); word(fd->arg_var_object_idx);
 word(fd->label_count); for(int i=0;i<fd->label_count;i++) { word(fd->label_slots[i].ref_count); word(fd->label_slots[i].pos2); }
}
'''
SILK_HELPERS = r'''
import js_compiler_variables as variables
import js_compiler_types { CompilerErrorKind }
import silk.result { Result }
import silk.list { List }
import silk.option { Option }
import silk.u32
import js_heap { HeapKind }
import js_value { ValueBits }
import js_core_types { ModuleDef, ModuleStatus, RequestedModule, ExportEntry, ExportBinding, ImportEntry, StarExportEntry, FunctionBytecode, FunctionKind, ByteStorage, ClosureVar, VarDef, FunctionDebugInfo }
effect fn prepareGlobal(cell:*mut HeapHeader)->i32 ! OutOfMemoryError | StringLengthError | CompilerError ? &mut Allocator { run unsafe variables.addGlobalVariables(cell) return 0 }
effect fn missingExport(error:CompilerError)->i32 { if error.kind!=CompilerErrorKind.MissingExport { Intrinsic.trap("QuickJS invariant violated") } return -1 }
effect fn makeModule()->*mut HeapHeader ! OutOfMemoryError ? &mut Allocator {
 return run HeapCell.allocate<ModuleDef>(HeapKind.Module,ModuleDef {
  name:0,previousModule:Pointer.null<HeapHeader>(),nextModule:Pointer.null<HeapHeader>(),
  requestedModules:List<RequestedModule>.make(),exports:List<ExportEntry>.make(),starExports:List<StarExportEntry>.make(),imports:List<ImportEntry>.make(),
  namespace:ValueBits.Undefined,functionObject:ValueBits.Undefined,initialize:Option<NativeFunctionId>.none(),
  hasTopLevelAwait:false,resolved:false,functionCreated:false,status:ModuleStatus.Unlinked,
  dfsIndex:-1,dfsAncestorIndex:-1,stackPrevious:Pointer.null<HeapHeader>(),
  asyncParentModules:List<*mut HeapHeader>.make(),pendingAsyncDependencies:0,asyncEvaluation:false,
  asyncEvaluationTimestamp:0,cycleRoot:Pointer.null<HeapHeader>(),promise:ValueBits.Undefined,
  resolvingFunctions:[ValueBits.Undefined;2],evaluationHasException:false,evaluationException:ValueBits.Undefined,
  metaObject:ValueBits.Undefined,privateValue:ValueBits.Undefined
 })
}
fn makeSnapshot(context:*mut HeapHeader)->FunctionBytecode {
 return FunctionBytecode { mode:0,hasPrototype:false,hasSimpleParameterList:false,isDerivedClassConstructor:false,needsHomeObject:false,kind:FunctionKind.Normal,
  newTargetAllowed:false,superCallAllowed:false,superAllowed:false,argumentsAllowed:false,readOnlyBytecode:false,isDirectOrIndirectEval:false,
  code:ByteStorage.Owned { bytes:List<u8>.make() },name:0,varDefs:List<VarDef>.make(),closureVars:List<ClosureVar>.make(),
  argumentCount:1,variableCount:4,definedArgumentCount:0,stackSize:0,varRefCount:0,realm:context,constants:List<ValueBits>.make(),debug:Option<FunctionDebugInfo>.none()
 }
}
fn snapshotVar(name:u32,scoped:bool,next:i32)->VarDef {
 return VarDef { name:name,scopeNext:next,isConst:scoped,isLexical:scoped,isCaptured:false,hasScope:scoped,kind:VariableKind.Normal,varRefIndex:0 }
}
fn vk(kind:VariableKind)->i32 {
 return match kind { VariableKind.Normal=>0 VariableKind.FunctionDeclaration=>1 VariableKind.NewFunctionDeclaration=>2 VariableKind.Catch=>3 VariableKind.FunctionName=>4 VariableKind.PrivateField=>5 VariableKind.PrivateMethod=>6 VariableKind.PrivateGetter=>7 VariableKind.PrivateSetter=>8 VariableKind.PrivateGetterSetter=>9 VariableKind.GlobalFunctionDeclaration=>10 VariableKind.Using=>11 VariableKind.UsingMethod=>12 }
}
effect fn bit(out:&mut ByteBuffer,value:bool)->() ! OutOfMemoryError ? &mut Allocator { if value { run word(&mut out,1) } else { run word(&mut out,0) } }
effect fn dump(out:&mut ByteBuffer,fd:&FunctionDef)->() ! OutOfMemoryError ? &mut Allocator {
 run word(&mut out,usize.toI32(fd.bytecode.length())) let mut i:usize=0
 while i<fd.bytecode.length() { run word(&mut out,u8.toI32(fd.bytecode.get(i))) i=i+1 }
 run word(&mut out,usize.toI32(fd.jumpCapacity)) run word(&mut out,usize.toI32(fd.lineNumberCapacity)) run word(&mut out,fd.varRefCount)
 run word(&mut out,usize.toI32(fd.vars.length())) i=0
 while i<fd.vars.length() { let v=fd.vars.get(i) run bit(&mut out,v.isCaptured) run word(&mut out,u16.toI32(v.varRefIndex)) run word(&mut out,v.scopeNext) if v.name<atoms.JS_ATOM_END { run word(&mut out,u32.toI32(v.name)) } else { run word(&mut out,-1) } run bit(&mut out,v.isLexical) run bit(&mut out,v.isConst) run word(&mut out,vk(v.kind)) i=i+1 }
 run word(&mut out,usize.toI32(fd.args.length())) i=0
 while i<fd.args.length() { let v=fd.args.get(i) run bit(&mut out,v.isCaptured) run word(&mut out,u16.toI32(v.varRefIndex)) i=i+1 }
 run word(&mut out,usize.toI32(fd.closureVars.length())) i=0
 while i<fd.closureVars.length() { let v=fd.closureVars.get(i) run word(&mut out,closureKind(v.kind)) run word(&mut out,u16.toI32(v.variableIndex)) run bit(&mut out,v.isConst) run bit(&mut out,v.isLexical) run word(&mut out,vk(v.variableKind)) if v.name<atoms.JS_ATOM_END { run word(&mut out,u32.toI32(v.name)) } else { run word(&mut out,-1) } i=i+1 }
 run word(&mut out,usize.toI32(fd.scopes.length())) i=0
 while i<fd.scopes.length() { let scope=fd.scopes.get(i) run word(&mut out,scope.first) run word(&mut out,scope.parent) i=i+1 }
 run word(&mut out,fd.thisVarIndex) run word(&mut out,fd.newTargetVarIndex) run word(&mut out,fd.homeObjectVarIndex) run word(&mut out,fd.thisActiveFunctionVarIndex) run word(&mut out,fd.argumentsVarIndex) run word(&mut out,fd.argumentsArgIndex) run word(&mut out,fd.functionVarIndex) run word(&mut out,fd.varObjectIndex) run word(&mut out,fd.argVarObjectIndex)
 run word(&mut out,usize.toI32(fd.labels.length())) i=0
 while i<fd.labels.length() { let label=fd.labels.get(i) run word(&mut out,label.referenceCount) run word(&mut out,label.position2) i=i+1 }
}
'''


def sources(cases):
    c = [C_HEADER]
    # Reuse only runtime lifetime scaffolding, never a variable-pass expectation.
    s = [STATE_SOURCE.split('effect fn probe()')[0], SILK_HELPERS]
    for number, (_, cs, ss) in enumerate(cases):
        cs, _, c_cleanup = cs.partition('// CLEANUP')
        ss, _, silk_cleanup = ss.partition('// CLEANUP')
        c.append(f'''static void case_{number}(JSContext *ctx) {{
 int baseline=ctx->rt->atom_count;
 const uint8_t source[]=""; GetLineColCache cache={{0}}; cache.buf_start=source; cache.ptr=source;
 JSFunctionDef *root=js_new_function_def(ctx,NULL,TRUE,FALSE,"probe",source,&cache), *fd=root;
 {cs}
 int result=resolve_variables(ctx,fd); word(result);
 if(result<0) {{ JSValue error=JS_GetException(ctx); JS_FreeValue(ctx,error); }}
 dump(fd); if(fd!=root) dump(root);
 {c_cleanup}
 js_free_function_def(ctx,root); word(ctx->rt->atom_count-baseline);
}}''')
        s.append(f'''effect fn case{number}(out:&mut ByteBuffer,runtime:*mut HeapHeader,context:*mut HeapHeader)->() ! OutOfMemoryError | StringLengthError | CompilerError ? &mut Allocator {{
 let baselineAnchor=() let baselineState=unsafe HeapCell.payload<RuntimeState,()>(&baselineAnchor,runtime) let baseline=baselineState.atoms.count() drop baselineState
 let root=run unsafe state.newFunction(context,Pointer.null<HeapHeader>(),true,false,0,0,Pointer.null<SourcePositionCache>())
 let mut cell=root let mut a=() let mut r=()
 {ss}
 let result=run Effect.result(unsafe variables.resolveVariables(cell))
 match move result {{
  Result<(),OutOfMemoryError | StringLengthError | CompilerError>.Success {{ .. }} => {{ run word(&mut out,0) }}
  Result<(),OutOfMemoryError | StringLengthError | CompilerError>.Failure {{ error }} => {{
   match move error {{
    OutOfMemoryError e => {{ fail move e }}
    StringLengthError e => {{ fail move e }}
    CompilerError diagnostic => {{ if diagnostic.kind!=CompilerErrorKind.UndefinedPrivateField || diagnostic.atom!=atoms.JS_ATOM_name {{ Intrinsic.trap("QuickJS invariant violated") }} run word(&mut out,-1) }}
   }}
  }}
 }}
 let resolved=unsafe HeapCell.payload<FunctionDef,()>(&a,cell) run dump(&mut out,&resolved.*) drop resolved
 if Pointer.address<HeapHeader>(cell)!=Pointer.address<HeapHeader>(root) {{ let parent=unsafe HeapCell.payload<FunctionDef,()>(&a,root) run dump(&mut out,&parent.*) }}
 {silk_cleanup}
 let mut hooks=NoClassEdges {{}} unsafe state.destroyFunction(&mut hooks,root)
 let remaining=unsafe HeapCell.payload<RuntimeState,()>(&a,runtime) run word(&mut out,usize.toI32(remaining.atoms.count())-usize.toI32(baseline))
}}''')
    c += ['int main(void) { JSRuntime *rt=JS_NewRuntime(); JSContext *ctx=JS_NewContext(rt); if(!ctx) return 2;',
          *(f'case_{i}(ctx);' for i in range(len(cases))), 'JS_FreeContext(ctx); JS_FreeRuntime(rt); return 0; }']
    s += ['effect fn probe()->() ! OutOfMemoryError | StringLengthError | CompilerError | WriterError ? &mut Allocator | &mut Writer { let runtime=run allocateRuntimeStorage(0) let context=run unsafe allocateContextStorage(runtime) let mut out=ByteBuffer.make()',
          *(f'run case{i}(&mut out,runtime,context)' for i in range(len(cases))),
          'let mut hooks=NoClassEdges {} unsafe js_gc.releaseHeader(&mut hooks,runtime,context) run unsafe js_gc.destroyRuntime(&mut hooks,runtime) run Writer.writeAll(out.asSlice()) }',
          STATE_SOURCE[STATE_SOURCE.index('pub effect fn main()'):]]
    return '\n'.join(c), '\n'.join(s)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', type=Path)
    parser.add_argument('--silk', default=str(toolchain.compiler_path()))
    parser.add_argument('--stdlib', type=Path, default=toolchain.stdlib_path())
    parser.add_argument('--cc', default='cc')
    args = parser.parse_args()
    upstream = args.upstream.expanduser().resolve()
    pins = validate_pins(upstream)
    cases = fixtures()
    c_source, silk_source = sources(cases)
    with tempfile.TemporaryDirectory(prefix='silkjs-compiler-variables-') as directory:
        temp = Path(directory).resolve()
        (temp / 'oracle.c').write_text(c_source)
        execute([executable_path(args.cc), '-O2', '-std=gnu11', '-fwrapv', '-funsigned-char', '-U__SIZEOF_INT128__', '-D_GNU_SOURCE', '-DCONFIG_VERSION="differential"', '-I', str(upstream), str(temp / 'oracle.c'), *(str(upstream / name) for name in SUPPORT), '-lm', '-lpthread', '-o', str(temp / 'oracle')])
        expected = execute([str(temp / 'oracle')])
        shutil.copytree(ROOT / 'src', temp / 'src')
        (temp / 'src/main.silk').write_text(silk_source)
        version = tomllib.loads((ROOT / 'silk.toml').read_text())['package']['silk-version']
        (temp / 'silk.toml').write_text(f'[package]\nname="compiler-variables-oracle"\nversion="0.0.0"\nsilk-version="{version}"\n')
        command = [executable_path(args.silk), 'run', '--quiet', '--release']
        if args.stdlib: command += ['--stdlib', str(args.stdlib.expanduser().resolve())]
        actual = execute(command, cwd=temp)
        if not expected or len(expected) % 4: raise SystemExit('invalid original-C records')
        if actual != expected:
            for offset in range(0, max(len(expected), len(actual)), 4):
                if actual[offset:offset+4] != expected[offset:offset+4]:
                    raise SystemExit(f'variable record {offset//4}: C={expected[offset:offset+4].hex()} Silk={actual[offset:offset+4].hex()}; lengths={len(expected)}/{len(actual)}')
        print(f'PASS variables: {len(cases)} fixtures; {len(actual)//4} words; {pins} pins; sha256={hashlib.sha256(actual).hexdigest()}')

if __name__ == '__main__':
    main()
