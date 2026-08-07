# Kotlin serialization resolves serializers through generated companions.
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault,Signature,InnerClasses,EnclosingMethod
-if @kotlinx.serialization.Serializable class **
-keepclassmembers class <1> {
    static <1>$Companion Companion;
}

# Room emits all required keep rules. Retain database constructors for old OEM VMs.
-keep class * extends androidx.room.RoomDatabase { <init>(); }

# Release builds must not retain application logging calls.
-assumenosideeffects class android.util.Log {
    public static *** v(...);
    public static *** d(...);
    public static *** i(...);
    public static *** w(...);
    public static *** e(...);
    public static *** wtf(...);
}
