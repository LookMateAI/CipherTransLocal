# Keep methods called from Rust/tao through JNI. The generated Wry rule keeps
# several helpers but does not list getId(), which release minification can
# rename and then crash at app startup.
-keep class com.ciphertranslocal.app.WryActivity {
  public int getId();
  public android.content.Intent getIntent();
  public java.lang.String getLocalClassName();
  public android.view.WindowManager getWindowManager();
  public boolean isChangingConfigurations();
}

-keepclassmembers class com.ciphertranslocal.app.WryActivity {
  public int getId();
}
