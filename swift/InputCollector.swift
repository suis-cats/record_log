import Foundation
import CoreGraphics
import ApplicationServices
let start=DispatchTime.now().uptimeNanoseconds
var previousKey:Double?,movementX=0.0,movementY=0.0,lastPoint:CGPoint?
let lock=NSLock()
func mono()->Double{Double(DispatchTime.now().uptimeNanoseconds-start)/1_000_000}
func emit(_ type:String,_ fields:[String:Any?]=[:]){var row:[String:Any]=["type":type,"timestamp_ms":Date().timeIntervalSince1970*1000,"monotonic_ms":mono()];for(k,v)in fields{row[k]=v ?? NSNull()};if let d=try? JSONSerialization.data(withJSONObject:row),let s=String(data:d,encoding:.utf8){lock.lock();print(s);fflush(stdout);lock.unlock()}}
let trusted=AXIsProcessTrusted();emit("permission",["granted":trusted]);if !trusted{exit(77)}
let types:[CGEventType]=[.keyDown,.leftMouseDown,.rightMouseDown,.otherMouseDown,.scrollWheel,.mouseMoved,.leftMouseDragged,.rightMouseDragged]
let mask=types.reduce(CGEventMask(0)){$0|(CGEventMask(1)<<$1.rawValue)}
let callback:CGEventTapCallBack={_,type,event,_ in
 switch type {
 case .keyDown: let now=mono(),interval=previousKey.map{now-$0};previousKey=now;emit("keydown",["interval_ms":interval])
 case .leftMouseDown,.rightMouseDown,.otherMouseDown: emit("click")
 case .scrollWheel: emit("scroll",["scroll_x":event.getDoubleValueField(.scrollWheelEventPointDeltaAxis2),"scroll_y":event.getDoubleValueField(.scrollWheelEventPointDeltaAxis1)])
 case .mouseMoved,.leftMouseDragged,.rightMouseDragged: let point=event.location;if let old=lastPoint{lock.lock();movementX += abs(point.x-old.x);movementY += abs(point.y-old.y);lock.unlock()};lastPoint=point
 case .tapDisabledByTimeout,.tapDisabledByUserInput: emit("gap",["reason":"event_tap_disabled"])
 default: break
 };return Unmanaged.passUnretained(event)
}
guard let tap=CGEvent.tapCreate(tap:.cgSessionEventTap,place:.headInsertEventTap,options:.listenOnly,eventsOfInterest:mask,callback:callback,userInfo:nil)else{emit("gap",["reason":"event_tap_create_failed"]);exit(78)}
let source=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,tap,0);CFRunLoopAddSource(CFRunLoopGetCurrent(),source,.commonModes);CGEvent.tapEnable(tap:tap,enable:true)
let timer=Timer(timeInterval:1,repeats:true){_ in lock.lock();let x=movementX,y=movementY;movementX=0;movementY=0;lock.unlock();emit("movement",["delta_x":x,"delta_y":y]);emit("heartbeat")}
RunLoop.current.add(timer,forMode:.common);emit("heartbeat");CFRunLoopRun()
