import javascript
import lib.simple.SimpleSinks
import semmle.javascript.security.dataflow.RemoteFlowSources

module TTPathCfg implements DataFlow::ConfigSig {
  predicate isSource(DataFlow::Node n) { n instanceof RemoteFlowSource }

  predicate isSink(DataFlow::Node n) {
    exists(TTSinkExpr sink | n = DataFlow::valueNode(sink.getValueExpr()))
  }

  predicate isAdditionalFlowStep(DataFlow::Node pred, DataFlow::Node succ) {
    isTransformTaintStep(pred, succ)
  }
}

module TTPathFlow = TaintTracking::Global<TTPathCfg>;
import TTPathFlow::PathGraph

from TTPathFlow::PathNode source, TTPathFlow::PathNode sink,
     TTSinkExpr sinkExpr, string sourceKind
where
  TTPathFlow::flowPath(source, sink) and
  sink.getNode() = DataFlow::valueNode(sinkExpr.getValueExpr()) and
  source.getNode() instanceof RemoteFlowSource and
  sourceKind = source.getNode().(RemoteFlowSource).getSourceType() and
  not isExcludedFile(sinkExpr.getFile()) and
  not isMinifiedCode(sinkExpr)
select sinkExpr, source, sink,
       sinkExpr.getSinkKind() + "||" + sourceKind + "||" +
       sinkExpr.getFile().getRelativePath() + "||" +
       sinkExpr.getLocation().getStartLine().toString() + "||" +
       sinkExpr.getLocation().getStartColumn().toString() + "||" +
       source.getNode().getLocation().getFile().getRelativePath() + "||" +
       source.getNode().getLocation().getStartLine().toString() + "||" +
       source.getNode().getLocation().getStartColumn().toString()
