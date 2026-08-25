import javascript

string literalStr(Expr e) {
  result = e.(StringLiteral).getValue()
}

predicate isDefinitelyCallable(Expr e) {
  e instanceof Function
  or
  e instanceof ArrowFunctionExpr
  or

  e.(CallExpr).getCallee().(PropAccess).getPropertyName() = "bind"
  or

  exists(Variable v |
    e.(VarAccess).getVariable() = v and
    forex(Expr assigned | assigned = v.getAnAssignedExpr() |
      isDefinitelyCallable(assigned)
    )
  )
}

predicate isExcludedFile(File f) {
  f.getRelativePath()
    .regexpMatch("(?i)(|.*/)"
      + "("
      + "dist|build|out|output"
      + "|node_modules|bower_components|vendor"
      + "|test|tests|__tests__|spec|specs|e2e"
      + "|coverage|\\.nyc_output"
      + "|fixtures|mocks|__mocks__"
      + "|examples?|demos?|samples?"
      + ")/.*")
  or
  f.getBaseName().regexpMatch("(?i).*\\.(min|bundle|pack|chunk|vendor|polyfill)\\.[jt]sx?$")
  or
  f.getStem().regexpMatch("(?i).*([-_.])(min|bundle|pack|chunk|vendor|polyfill)$")
}

predicate isMinifiedCode(Expr e) {
  e.getLocation().getStartColumn() > 500
}

predicate isDefinitelyDocument(Expr recv) {
  recv.(VarAccess).getName() = "document"
  or
  recv.(PropAccess).getPropertyName() = "document"
  or
  recv.(PropAccess).getPropertyName() = "contentDocument"
  or
  exists(Variable v |
    recv.(VarAccess).getVariable() = v and
    forex(Expr assigned | assigned = v.getAnAssignedExpr() |
      isDefinitelyDocument(assigned)
    )
  )
}

predicate isDefinitelyJqueryReceiver(Expr e) {

  e.(CallExpr).getCallee().(GlobalVarAccess).getName() in ["$", "jQuery"]
  or

  isDefinitelyJqueryReceiver(e.(MethodCallExpr).getReceiver())
  or

  exists(Variable v |
    e.(VarAccess).getVariable() = v and
    forex(Expr assigned | assigned = v.getAnAssignedExpr() |
      isDefinitelyJqueryReceiver(assigned)
    )
  )
}

predicate isScriptCreateCall(Expr e) {
  e.(MethodCallExpr).getMethodName() = "createElement" and
  literalStr(e.(MethodCallExpr).getArgument(0)).toLowerCase() = "script"
}

predicate isDefinitelyScriptElem(Expr recv) {
  isScriptCreateCall(recv)
  or
  exists(Variable v |
    recv.(VarAccess).getVariable() = v and
    isScriptCreateCall(v.getAnAssignedExpr())
  )
}

predicate isDefinitelySvgScriptElem(Expr recv) {
  (
    recv.(MethodCallExpr).getMethodName() = "createElementNS" and
    literalStr(recv.(MethodCallExpr).getArgument(1)).toLowerCase() = "script"
  )
  or
  exists(Variable v, Expr init |
    recv.(VarAccess).getVariable() = v and
    init = v.getAnAssignedExpr() and
    init.(MethodCallExpr).getMethodName() = "createElementNS" and
    literalStr(init.(MethodCallExpr).getArgument(1)).toLowerCase() = "script"
  )
}

abstract class TTSinkExpr extends Expr {

  abstract string getSinkKind();

  abstract Expr getValueExpr();
}

class InnerHtmlSink extends TTSinkExpr, Assignment {
  InnerHtmlSink() { this.getLhs().(PropAccess).getPropertyName() = "innerHTML" }
  override string getSinkKind() { result = "html.element.innerHTML" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class OuterHtmlSink extends TTSinkExpr, Assignment {
  OuterHtmlSink() { this.getLhs().(PropAccess).getPropertyName() = "outerHTML" }
  override string getSinkKind() { result = "html.element.outerHTML" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class IframeSrcdocSink extends TTSinkExpr, Assignment {
  IframeSrcdocSink() { this.getLhs().(PropAccess).getPropertyName() = "srcdoc" }
  override string getSinkKind() { result = "html.iframe.srcdoc" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class InsertAdjacentHtmlSink extends TTSinkExpr, MethodCallExpr {
  InsertAdjacentHtmlSink() { this.getMethodName() = "insertAdjacentHTML" }
  override string getSinkKind() { result = "html.element.insertAdjacentHTML" }
  override Expr getValueExpr() { result = this.getArgument(1) }
}

class SetHtmlUnsafeSink extends TTSinkExpr, MethodCallExpr {
  SetHtmlUnsafeSink() { this.getMethodName() = "setHTMLUnsafe" }
  override string getSinkKind() { result = "html.element.setHTMLUnsafe" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class DocumentWriteSink extends TTSinkExpr, MethodCallExpr {
  DocumentWriteSink() {
    this.getMethodName() = "write" and
    isDefinitelyDocument(this.getReceiver())
  }
  override string getSinkKind() { result = "html.document.write" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class DocumentWritelnSink extends TTSinkExpr, MethodCallExpr {
  DocumentWritelnSink() {
    this.getMethodName() = "writeln" and
    isDefinitelyDocument(this.getReceiver())
  }
  override string getSinkKind() { result = "html.document.writeln" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class ParseHtmlUnsafeSink extends TTSinkExpr, MethodCallExpr {
  ParseHtmlUnsafeSink() { this.getMethodName() = "parseHTMLUnsafe" }
  override string getSinkKind() { result = "html.document.parseHTMLUnsafe" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class DomParserSink extends TTSinkExpr, MethodCallExpr {
  DomParserSink() { this.getMethodName() = "parseFromString" }
  override string getSinkKind() { result = "html.domParser.parseFromString" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class CreateContextualFragmentSink extends TTSinkExpr, MethodCallExpr {
  CreateContextualFragmentSink() { this.getMethodName() = "createContextualFragment" }
  override string getSinkKind() { result = "html.range.createContextualFragment" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class JqueryHtmlSink extends TTSinkExpr, MethodCallExpr {
  JqueryHtmlSink() {
    this.getMethodName() = "html" and
    exists(this.getArgument(0)) and
    isDefinitelyJqueryReceiver(this.getReceiver())
  }
  override string getSinkKind() { result = "html.jquery.html" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class JqueryManipSink extends TTSinkExpr, MethodCallExpr {
  JqueryManipSink() {
    this.getMethodName() in ["append", "prepend", "after", "before"] and
    isDefinitelyJqueryReceiver(this.getReceiver())
  }
  override string getSinkKind() { result = "html.jquery." + this.getMethodName() }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class JqueryReplaceWrapSink extends TTSinkExpr, MethodCallExpr {
  JqueryReplaceWrapSink() {
    this.getMethodName() in ["replaceWith", "wrap"] and
    isDefinitelyJqueryReceiver(this.getReceiver())
  }
  override string getSinkKind() { result = "html.jquery." + this.getMethodName() }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class DangerouslySetInnerHtmlSink extends TTSinkExpr {
  DangerouslySetInnerHtmlSink() {

    exists(JsxAttribute attr, ObjectExpr obj, Property htmlProp |
      attr.getName() = "dangerouslySetInnerHTML" and
      obj = attr.getValue() and
      htmlProp = obj.getAProperty() and
      htmlProp.getName() = "__html" and
      this = htmlProp.getInit()
    )
    or

    exists(DataFlow::Node danger, DataFlow::SourceNode valueSrc,
           DataFlow::ObjectLiteralNode props |
      exists(MethodCallExpr ce |
        ce.getMethodName() = "createElement" and
        props.flowsTo(DataFlow::valueNode(ce.getArgument(1))) and
        props.hasPropertyWrite("dangerouslySetInnerHTML", danger)
      ) and
      valueSrc.flowsTo(danger) and
      valueSrc.hasPropertyWrite("__html", DataFlow::valueNode(this))
    )
  }
  override string getSinkKind() { result = "html.react.dangerouslySetInnerHTML" }
  override Expr getValueExpr() { result = this }
}

class ExecCommandInsertHtmlSink extends TTSinkExpr, MethodCallExpr {
  ExecCommandInsertHtmlSink() {
    this.getMethodName() = "execCommand" and
    literalStr(this.getArgument(0)).toLowerCase() = "inserthtml"
  }
  override string getSinkKind() { result = "html.document.execCommand.insertHTML" }
  override Expr getValueExpr() { result = this.getArgument(2) }
}

class SetAttributeSrcdocSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeSrcdocSink() {
    this.getMethodName() = "setAttribute" and
    literalStr(this.getArgument(0)).toLowerCase() = "srcdoc"
  }
  override string getSinkKind() { result = "html.iframe.setAttribute.srcdoc" }
  override Expr getValueExpr() { result = this.getArgument(1) }
}

class SetAttributeNsSrcdocSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeNsSrcdocSink() {
    this.getMethodName() = "setAttributeNS" and
    literalStr(this.getArgument(1)).toLowerCase() = "srcdoc"
  }
  override string getSinkKind() { result = "html.iframe.setAttributeNS.srcdoc" }
  override Expr getValueExpr() { result = this.getArgument(2) }
}

class EvalSink extends TTSinkExpr, CallExpr {
  EvalSink() {

    this.getCallee().(GlobalVarAccess).getName() = "eval"
    or

    exists(IndexExpr ie |
      ie = this.getCallee() and
      ie.getBase().(VarAccess).getName() = "window" and
      ie.getIndex().(StringLiteral).getValue() = "eval"
    )
    or

    this.getCallee().(PropAccess).getPropertyName() = "eval" and
    this.getCallee().(PropAccess).getBase().(VarAccess).getName() = "window"
  }
  override string getSinkKind() { result = "script.eval" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class EvalCallSink extends TTSinkExpr, MethodCallExpr {
  EvalCallSink() {
    this.getMethodName() in ["call", "apply"] and
    exists(IndexExpr ie |
      ie = this.getReceiver() and
      ie.getBase().(VarAccess).getName() = "window" and
      ie.getIndex().(StringLiteral).getValue() = "eval"
    )
  }
  override string getSinkKind() { result = "script.eval" }
  override Expr getValueExpr() { result = this.getArgument(1) }
}

class SetTimeoutSink extends TTSinkExpr, CallExpr {
  SetTimeoutSink() {
    (
      this.getCallee().(GlobalVarAccess).getName() = "setTimeout"
      or

      this.getCallee().(PropAccess).getPropertyName() = "setTimeout" and
      this.getCallee().(PropAccess).getBase().(VarAccess).getName() = "window"
    ) and
    exists(this.getArgument(0))
  }
  override string getSinkKind() { result = "script.setTimeout.string" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class SetIntervalSink extends TTSinkExpr, CallExpr {
  SetIntervalSink() {
    (
      this.getCallee().(GlobalVarAccess).getName() = "setInterval"
      or

      this.getCallee().(PropAccess).getPropertyName() = "setInterval" and
      this.getCallee().(PropAccess).getBase().(VarAccess).getName() = "window"
    ) and
    exists(this.getArgument(0))
  }
  override string getSinkKind() { result = "script.setInterval.string" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class LocationHrefSink extends TTSinkExpr, Assignment {
  LocationHrefSink() {
    this.getLhs().(PropAccess).getPropertyName() = "href" and
    (
      this.getLhs().(PropAccess).getBase().(VarAccess).getName() = "location"
      or

      this.getLhs().(PropAccess).getBase().(PropAccess).getPropertyName() = "location"
    )
  }
  override string getSinkKind() { result = "script.location.href.javascript" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class LocationAssignSink extends TTSinkExpr, MethodCallExpr {
  LocationAssignSink() {
    this.getMethodName() = "assign" and
    (
      this.getReceiver().(VarAccess).getName() = "location"
      or
      this.getReceiver().(PropAccess).getPropertyName() = "location"
    )
  }
  override string getSinkKind() { result = "script.location.assign.javascript" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class LocationReplaceSink extends TTSinkExpr, MethodCallExpr {
  LocationReplaceSink() {
    this.getMethodName() = "replace" and
    (
      this.getReceiver().(VarAccess).getName() = "location"
      or
      this.getReceiver().(PropAccess).getPropertyName() = "location"
    )
  }
  override string getSinkKind() { result = "script.location.replace.javascript" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class WindowOpenSink extends TTSinkExpr, MethodCallExpr {
  WindowOpenSink() {
    this.getMethodName() = "open" and
    (
      this.getReceiver().(VarAccess).getName() = "window"
      or
      this.getReceiver().(PropAccess).getPropertyName() = "contentWindow"
    )
  }
  override string getSinkKind() { result = "script.window.open.javascript" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class FunctionCtorSink extends TTSinkExpr, InvokeExpr {
  FunctionCtorSink() { this.getCallee().(GlobalVarAccess).getName() = "Function" }
  override string getSinkKind() { result = "script.Function.ctor" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class AsyncFunctionCtorSink extends TTSinkExpr, InvokeExpr {
  AsyncFunctionCtorSink() { this.getCallee().(GlobalVarAccess).getName() = "AsyncFunction" }
  override string getSinkKind() { result = "script.AsyncFunction.ctor" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class GeneratorFunctionCtorSink extends TTSinkExpr, InvokeExpr {
  GeneratorFunctionCtorSink() { this.getCallee().(GlobalVarAccess).getName() = "GeneratorFunction" }
  override string getSinkKind() { result = "script.GeneratorFunction.ctor" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class AsyncGeneratorFunctionCtorSink extends TTSinkExpr, InvokeExpr {
  AsyncGeneratorFunctionCtorSink() {
    this.getCallee().(GlobalVarAccess).getName() = "AsyncGeneratorFunction"
  }
  override string getSinkKind() { result = "script.AsyncGeneratorFunction.ctor" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class ScriptTextSink extends TTSinkExpr, Assignment {
  ScriptTextSink() {
    this.getLhs().(PropAccess).getPropertyName() = "text" and
    isDefinitelyScriptElem(this.getLhs().(PropAccess).getBase())
  }
  override string getSinkKind() { result = "script.text" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class ScriptTextContentSink extends TTSinkExpr, Assignment {
  ScriptTextContentSink() {
    this.getLhs().(PropAccess).getPropertyName() = "textContent" and
    isDefinitelyScriptElem(this.getLhs().(PropAccess).getBase())
  }
  override string getSinkKind() { result = "script.textContent" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class ScriptInnerTextSink extends TTSinkExpr, Assignment {
  ScriptInnerTextSink() {
    this.getLhs().(PropAccess).getPropertyName() = "innerText" and
    isDefinitelyScriptElem(this.getLhs().(PropAccess).getBase())
  }
  override string getSinkKind() { result = "script.innerText" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class SetAttributeOnEventSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeOnEventSink() {
    this.getMethodName() = "setAttribute" and
    literalStr(this.getArgument(0)).toLowerCase().matches("on%")
  }
  override string getSinkKind() { result = "script.element.setAttribute.onEvent" }
  override Expr getValueExpr() { result = this.getArgument(1) }
}

class SetAttributeNsOnEventSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeNsOnEventSink() {
    this.getMethodName() = "setAttributeNS" and
    literalStr(this.getArgument(1)).toLowerCase().matches("on%")
  }
  override string getSinkKind() { result = "script.element.setAttributeNS.onEvent" }
  override Expr getValueExpr() { result = this.getArgument(2) }
}

class ScriptSrcSink extends TTSinkExpr, Assignment {
  ScriptSrcSink() {
    this.getLhs().(PropAccess).getPropertyName() = "src" and
    isDefinitelyScriptElem(this.getLhs().(PropAccess).getBase())
  }
  override string getSinkKind() { result = "scriptURL.script.src" }
  override Expr getValueExpr() { result = this.getRhs() }
}

class WorkerCtorSink extends TTSinkExpr, NewExpr {
  WorkerCtorSink() { this.getCallee().(GlobalVarAccess).getName() = "Worker" }
  override string getSinkKind() { result = "scriptURL.Worker.ctor" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class SharedWorkerCtorSink extends TTSinkExpr, NewExpr {
  SharedWorkerCtorSink() { this.getCallee().(GlobalVarAccess).getName() = "SharedWorker" }
  override string getSinkKind() { result = "scriptURL.SharedWorker.ctor" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class ImportScriptsSink extends TTSinkExpr, CallExpr {
  ImportScriptsSink() { this.getCallee().(GlobalVarAccess).getName() = "importScripts" }
  override string getSinkKind() { result = "scriptURL.importScripts" }
  override Expr getValueExpr() { result = this.getAnArgument() }
}

class ServiceWorkerRegisterSink extends TTSinkExpr, MethodCallExpr {
  ServiceWorkerRegisterSink() {
    this.getMethodName() = "register" and
    this.getReceiver().(PropAccess).getPropertyName() = "serviceWorker"
  }
  override string getSinkKind() { result = "scriptURL.serviceWorker.register" }
  override Expr getValueExpr() { result = this.getArgument(0) }
}

class SetAttributeSrcSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeSrcSink() {
    this.getMethodName() = "setAttribute" and
    literalStr(this.getArgument(0)).toLowerCase() = "src" and
    isDefinitelyScriptElem(this.getReceiver())
  }
  override string getSinkKind() { result = "scriptURL.script.setAttribute.src" }
  override Expr getValueExpr() { result = this.getArgument(1) }
}

class SetAttributeNsSrcSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeNsSrcSink() {
    this.getMethodName() = "setAttributeNS" and
    literalStr(this.getArgument(1)).toLowerCase() = "src" and
    isDefinitelyScriptElem(this.getReceiver())
  }
  override string getSinkKind() { result = "scriptURL.script.setAttributeNS.src" }
  override Expr getValueExpr() { result = this.getArgument(2) }
}

class SetAttributeHrefSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeHrefSink() {
    this.getMethodName() = "setAttribute" and
    literalStr(this.getArgument(0)).toLowerCase() = "href" and
    isDefinitelySvgScriptElem(this.getReceiver())
  }
  override string getSinkKind() { result = "scriptURL.svgScript.setAttribute.href" }
  override Expr getValueExpr() { result = this.getArgument(1) }
}

class SetAttributeNsHrefSink extends TTSinkExpr, MethodCallExpr {
  SetAttributeNsHrefSink() {
    this.getMethodName() = "setAttributeNS" and
    literalStr(this.getArgument(1)).toLowerCase() = "href" and
    isDefinitelySvgScriptElem(this.getReceiver())
  }
  override string getSinkKind() { result = "scriptURL.svgScript.setAttributeNS.href" }
  override Expr getValueExpr() { result = this.getArgument(2) }
}

predicate isTTSink(Expr sink, string kind) {
  kind = sink.(TTSinkExpr).getSinkKind()
}

Expr getSinkValueExpr(Expr sink) {
  result = sink.(TTSinkExpr).getValueExpr()
}

string tierForKind(string kind) {
  kind in [
    "html.element.innerHTML", "html.element.outerHTML",
    "html.element.insertAdjacentHTML", "html.element.setHTMLUnsafe",
    "html.iframe.srcdoc",
    "html.document.write", "html.document.writeln",
    "html.document.parseHTMLUnsafe",
    "html.domParser.parseFromString",
    "html.range.createContextualFragment",
    "html.react.dangerouslySetInnerHTML",
    "script.Function.ctor", "script.AsyncFunction.ctor",
    "script.GeneratorFunction.ctor", "script.AsyncGeneratorFunction.ctor",
    "scriptURL.Worker.ctor", "scriptURL.SharedWorker.ctor",
    "scriptURL.importScripts", "scriptURL.serviceWorker.register"
  ] and result = "A"
  or
  kind in [
    "html.document.execCommand.insertHTML",
    "html.iframe.setAttribute.srcdoc", "html.iframe.setAttributeNS.srcdoc",
    "script.element.setAttribute.onEvent", "script.element.setAttributeNS.onEvent",
    "scriptURL.script.setAttribute.src", "scriptURL.script.setAttributeNS.src",
    "scriptURL.svgScript.setAttribute.href", "scriptURL.svgScript.setAttributeNS.href"
  ] and result = "B"
  or
  kind in [
    "script.text", "script.textContent", "script.innerText",
    "scriptURL.script.src"
  ] and result = "C"
  or
  kind in [
    "script.eval", "script.setTimeout.string", "script.setInterval.string",
    "script.location.href.javascript", "script.location.assign.javascript",
    "script.location.replace.javascript", "script.window.open.javascript"
  ] and result = "D"
  or
  kind in [
    "html.jquery.html", "html.jquery.append", "html.jquery.prepend",
    "html.jquery.after", "html.jquery.before",
    "html.jquery.replaceWith", "html.jquery.wrap"
  ] and result = "L"
}

predicate isTransformTaintStep(DataFlow::Node pred, DataFlow::Node succ) {
  exists(DataFlow::CallNode call |
    succ = call and
    pred = call.getAnArgument() and
    (

      call instanceof DataFlow::MethodCallNode and
      call.(DataFlow::MethodCallNode).getMethodName() in [

        "decode", "encode",
        "decodeBase64Data",

        "parse", "stringify",
        "serialize", "deserialize",
        "toJSON", "fromJSON",

        "inflate", "deflate",
        "compress", "decompress",

        "transform", "convert",
        "extract", "unwrap",
        "format", "normalize",
        "toString"
      ]
      or

      call = DataFlow::globalVarRef(["atob", "btoa"]).getACall()
    )
  )
}

string ttTypeForKind(string kind) {

  exists(tierForKind(kind)) and
  (
    kind.matches("html.%") and result = "html"
    or
    kind.matches("script.%") and result = "script"
    or
    kind.matches("scriptURL.%") and result = "scriptURL"
  )
}
