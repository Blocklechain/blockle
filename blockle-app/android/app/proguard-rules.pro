# MediaPipe LLM inference (flutter_gemma) — R8 strips proto classes it reaches
# only reflectively; keep the whole MediaPipe surface + protobuf.
-keep class com.google.mediapipe.** { *; }
-keep class com.google.protobuf.** { *; }
-dontwarn com.google.mediapipe.**
-dontwarn com.google.protobuf.**
-keep class com.google.common.** { *; }
-dontwarn com.google.common.**
# AutoValue / generated references MediaPipe pulls in
-dontwarn javax.lang.model.**
-dontwarn autovalue.shaded.**
