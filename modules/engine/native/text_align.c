/* A 64-byte block placed first in the executable's code (startup.order
 * lists it before js_vm.execute), so the interpreter loop that follows
 * always starts on a 64-byte boundary. Its alignment moved with every
 * change to the code before it, and swung Crypto by about 15% at equal
 * instruction counts. Never called; retained against section GC.
 * WebAssembly code has no addresses to align, so that target gets nothing. */
#if defined(__wasm__)
typedef int silkjs_text_align_unused;
#elif defined(__APPLE__)
__asm__(".section __TEXT,__text,regular,pure_instructions\n"
        ".p2align 6\n"
        ".globl _silkjs_text_align\n"
        ".no_dead_strip _silkjs_text_align\n"
        "_silkjs_text_align:\n"
        ".fill 64,1,0xcc\n"
        ".text\n");
#else
__asm__(".section .text.silkjs_text_align,\"axR\",@progbits\n"
        ".p2align 6\n"
        ".globl silkjs_text_align\n"
        ".type silkjs_text_align,@function\n"
        "silkjs_text_align:\n"
        ".fill 64,1,0xcc\n"
        ".size silkjs_text_align, 64\n"
        ".text\n");
#endif
