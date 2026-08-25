// Ambient declarations for the Trusted Types runtime helpers the sink patcher
// injects into instrumented source. These only exist as browser globals once
// tt-bootstrap.js has loaded (see runtime/reverse-proxy/src/tt-policy.tpl.js);
// Angular's `ng build` type-checks the patched TypeScript and fails without
// this, even though the injected calls are valid at runtime.
declare const classifyPolicy: any;
declare const monitorPolicy: any;
declare const passThruPolicy: any;
declare const sanitizePolicy: any;
declare function __ttDispatch(...args: any[]): any;
declare function __ttDispatchExecCommand(...args: any[]): any;
declare function __ttDispatchSetAttr(...args: any[]): any;
declare function __ttGuardedPolicyCall(...args: any[]): any;
declare function __ttJQueryArg(...args: any[]): any;
