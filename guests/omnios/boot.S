/*
 * OmniOS 1.0 - the bundled OmniVM demo guest operating system.
 *
 * A tiny 16-bit x86 OS: boot sector + kernel in one flat image (1.44 MB
 * floppy). All console I/O goes to COM1 (115200 8N1) and is mirrored to
 * the VGA text screen via BIOS teletype, so it works both on the serial
 * console and on the VGA console.
 *
 * Build:  make   (GNU binutils: as --32, ld -m elf_i386, objcopy)
 *
 * Memory layout:
 *   0x0400  boot vars (boot drive, CHS state, boot tick count)
 *   0x0500  input line buffer
 *   0x0600  token buffer
 *   0x0700  arg pointer
 *   0x7C00  boot sector (loaded by BIOS)
 *   0x7E00  kernel (loaded from floppy sectors 2..25 by the bootloader)
 *   0x7BFE  stack top (grows down)
 */

	.code16
	.text
	.globl	_start

	.set	BOOTDRV, 0x0400		/* word: BIOS boot drive           */
	.set	CYL,     0x0402		/* word: current cylinder          */
	.set	HEAD,    0x0404		/* word: current head              */
	.set	SECT,    0x0406		/* word: current sector (1-based)  */
	.set	REM,     0x0408		/* word: sectors left to load      */
	.set	DEST,    0x040A		/* word: load destination offset   */
	.set	RETRY,   0x040C		/* byte: read retries              */
	.set	BTICKL,  0x0410		/* word: tick count at boot (lo)   */
	.set	BTICKH,  0x0412		/* word: tick count at boot (hi)   */
	.set	BUF,     0x0500		/* input line buffer               */
	.set	TOK,     0x0600		/* command token buffer            */
	.set	ARG,     0x0700		/* pointer to command arguments    */

/* ------------------------------------------------------------------ */
/* BOOT SECTOR                                                         */
/* ------------------------------------------------------------------ */
_start:
	xorw	%ax, %ax
	movw	%ax, %ds
	movw	%ax, %es
	movw	%ax, %ss
	movw	$0x7C00, %sp
	cld

	movw	%dx, BOOTDRV		/* save boot drive (BIOS passes in DL) */

	call	.Lb_uart_init

	movw	$MsgLoading, %si
	call	.Lb_puts

	/* ---- load kernel: 24 sectors from CHS 0/0/2 -> linear 0x7E00 ---- */
	movw	$24, REM
	movw	$2, SECT
	movw	$0, HEAD
	movw	$0, CYL
	movw	$0x7E00, DEST
	movb	$3, RETRY

.Lload:
	movw	DEST, %bx
	movw	REM, %ax		/* n = min(REM, 19 - SECT) */
	movw	$19, %dx
	subw	SECT, %dx
	cmpw	%dx, %ax
	jbe	.Lload_n
	movw	%dx, %ax
.Lload_n:
	pushw	%ax
	movb	CYL, %ch		/* CH = cylinder */
	movb	SECT, %cl		/* CL = sector */
	movb	HEAD, %dh		/* DH = head */
	movb	BOOTDRV, %dl
	popw	%ax
	movb	$2, %ah			/* AL = count, AH = 2 (read) */

	int	$0x13
	jnc	.Lload_ok

	call	disk_reset
	decb	RETRY
	jz	.Ldisk_fail
	jmp	.Lload

.Lload_ok:
	movw	%ax, %dx		/* n */
	pushw	%dx
	movb	$9, %cl
	shlw	%cl, %dx
	addw	%dx, DEST		/* DEST += n * 512 */
	popw	%dx
	addw	%dx, SECT		/* SECT += n */
	cmpw	$19, SECT
	jne	.Lload_more
	movw	$1, SECT
	xorw	$1, HEAD		/* flip head */
	cmpw	$0, HEAD
	jne	.Lload_more
	incw	CYL			/* wrapped to next cylinder */
.Lload_more:
	movw	REM, %ax
	subw	%dx, %ax		/* REM -= n */
	movw	%ax, REM
	testw	%ax, %ax
	jne	.Lload

	ljmp	$0, $kernel_start

.Ldisk_fail:
	movw	$MsgDiskFail, %si
	call	.Lb_puts
.Ldisk_hang:
	hlt
	jmp	.Ldisk_hang

/* ---- boot-local console routines (kernel routines are not loaded yet) ---- */
.Lb_uart_init:
	pushw	%ax
	pushw	%dx
	movw	$0x3FB, %dx
	movb	$0x80, %al
	outb	%al, %dx
	movw	$0x3F8, %dx
	movb	$0x01, %al
	outb	%al, %dx
	movw	$0x3F9, %dx
	xorb	%al, %al
	outb	%al, %dx
	movw	$0x3FB, %dx
	movb	$0x03, %al
	outb	%al, %dx
	popw	%dx
	popw	%ax
	ret

.Lb_sputc:
	pushw	%bx
	pushw	%dx
	movb	%al, %bl
	movw	$0x3FD, %dx
.Lb_spoll:
	inb	%dx, %al
	testb	$0x20, %al
	jz	.Lb_spoll
	movw	$0x3F8, %dx
	movb	%bl, %al
	outb	%al, %dx
	popw	%dx
	popw	%bx
	ret

/* DS:SI = string, serial only (boot-time console) */
.Lb_puts:
	lodsb
	testb	%al, %al
	jz	.Lb_puts_done
	cmpb	$0x0A, %al
	jne	.Lb_puts_c
	pushw	%ax
	movb	$0x0D, %al
	call	.Lb_sputc
	movb	$0x0A, %al
	call	.Lb_sputc
	popw	%ax
	jmp	.Lb_puts
.Lb_puts_c:
	call	.Lb_sputc
	jmp	.Lb_puts
.Lb_puts_done:
	ret

/* reset floppy engine (INT 13h AH=00) */
disk_reset:
	pushw	%ax
	pushw	%dx
	movb	$0, %ah
	movb	BOOTDRV, %dl
	int	$0x13
	popw	%dx
	popw	%ax
	ret

MsgLoading:	.asciz	"OmniOS bootloader: loading kernel ...\n"
MsgDiskFail:	.asciz	"\n*** DISK READ ERROR ***\n"

	.org	510
	.byte	0x55, 0xAA

/* ------------------------------------------------------------------ */
/* KERNEL  (linked at linear 0x7E00)                                   */
/* ------------------------------------------------------------------ */
	.org	512

kernel_start:
	xorw	%ax, %ax
	movw	%ax, %ds
	movw	%ax, %es
	movw	%ax, %ss
	movw	$0x7C00, %sp
	cld

	/* snapshot the BIOS tick counter for uptime */
	movw	0x046C, %ax
	movw	%ax, BTICKL
	movw	0x046E, %ax
	movw	%ax, BTICKH

	call	uart_init

	movw	$MsgBanner, %si
	call	puts
	movw	$MsgHello, %si
	call	puts

.Lshell:
	movw	$MsgPrompt, %si
	call	puts
	call	readline
	call	process_line
	jmp	.Lshell

/* ------------------------------------------------------------------ */
/* UART / console primitives                                           */
/* ------------------------------------------------------------------ */

/* COM1 = 0x3F8, 115200 8N1 */
uart_init:
	pushw	%ax
	pushw	%dx
	movw	$0x3FB, %dx		/* LCR: DLAB on */
	movb	$0x80, %al
	outb	%al, %dx
	movw	$0x3F8, %dx		/* divisor low: 1 = 115200 baud */
	movb	$0x01, %al
	outb	%al, %dx
	movw	$0x3F9, %dx		/* divisor high: 0 */
	xorb	%al, %al
	outb	%al, %dx
	movw	$0x3FB, %dx		/* LCR: 8N1, DLAB off */
	movb	$0x03, %al
	outb	%al, %dx
	movw	$0x3FA, %dx		/* FCR: enable + clear FIFOs */
	movb	$0xC7, %al
	outb	%al, %dx
	popw	%dx
	popw	%ax
	ret

/* AL = byte to COM1 (polls transmitter-empty, preserves CX) */
sputc:
	pushw	%bx
	pushw	%dx
	movb	%al, %bl
	movw	$0x3FD, %dx
.Lspoll:
	inb	%dx, %al
	testb	$0x20, %al
	jz	.Lspoll
	movw	$0x3F8, %dx
	movb	%bl, %al
	outb	%al, %dx
	popw	%dx
	popw	%bx
	ret

/* AL = char via BIOS teletype to the VGA text screen */
bputc:
	pushw	%ax
	pushw	%bx
	pushw	%cx
	pushw	%dx
	movb	$0x0E, %ah
	movw	$0x0007, %bx		/* page 0, attribute 7 */
	int	$0x10
	popw	%dx
	popw	%cx
	popw	%bx
	popw	%ax
	ret

/* AL = char: serial + VGA (LF expands to CRLF) */
putc:
	call	sputc
	cmpb	$0x0A, %al
	jne	.Lputc_vga
	pushw	%ax
	movb	$0x0D, %al
	call	bputc
	popw	%ax
.Lputc_vga:
	cmpb	$0x0D, %al		/* bare CR: serial only */
	je	.Lputc_done
	call	bputc
.Lputc_done:
	ret

/* DS:SI = NUL-terminated string */
puts:
	lodsb
	testb	%al, %al
	jz	.Lputs_done
	cmpb	$0x0A, %al
	jne	.Lputs_char
	pushw	%ax
	movb	$0x0D, %al
	call	putc
	movb	$0x0A, %al
	call	putc
	popw	%ax
	jmp	puts
.Lputs_char:
	call	putc
	jmp	puts
.Lputs_done:
	ret

/* DS:SI = raw string to COM1 only (for ANSI escapes) */
sputs:
	lodsb
	testb	%al, %al
	jz	.Lsputs_done
	call	sputc
	jmp	sputs
.Lsputs_done:
	ret

crlf:
	pushw	%ax
	movb	$0x0D, %al
	call	putc
	movb	$0x0A, %al
	call	putc
	popw	%ax
	ret

/* AX = unsigned 16-bit value, print decimal (preserves AX/CX/DX) */
print_dec:
	pushw	%ax
	pushw	%bx
	pushw	%cx
	pushw	%dx
	movw	$10, %bx
	xorw	%cx, %cx
.Lpd_split:
	xorw	%dx, %dx
	divw	%bx
	pushw	%dx
	incw	%cx
	testw	%ax, %ax
	jnz	.Lpd_split
.Lpd_emit:
	popw	%ax
	addb	$0x30, %al
	call	putc
	loop	.Lpd_emit
	popw	%dx
	popw	%cx
	popw	%bx
	popw	%ax
	ret

/* AX = 0..99, print with leading zero */
print_2d:
	cmpw	$10, %ax
	jae	.Lp2d
	pushw	%ax
	movb	$'0', %al
	call	putc
	popw	%ax
.Lp2d:
	call	print_dec
	ret

/* DX:AX = 32-bit dividend, CX = divisor -> AX quotient, DX remainder
 * (clobbers BX, SI, DI, BP; preserves CX) */
div32_16:
	pushw	%bx
	pushw	%si
	pushw	%di
	pushw	%bp
	movw	%ax, %si		/* SI = low dividend  */
	movw	%dx, %bx		/* BX = high dividend */
	xorw	%dx, %dx		/* DX = remainder     */
	movw	$16, %bp
.Ld_hi:
	shlw	$1, %bx			/* next bit of high word -> CF */
	rclw	$1, %dx			/* REM = REM<<1 | bit          */
	jnc	.Ld_hi_t
	subw	%cx, %dx
	jmp	.Ld_hi_n
.Ld_hi_t:
	cmpw	%cx, %dx
	jb	.Ld_hi_n
	subw	%cx, %dx
.Ld_hi_n:
	decw	%bp
	jnz	.Ld_hi
	xorw	%di, %di		/* DI = quotient */
	movw	$16, %bp
.Ld_lo:
	shlw	$1, %si
	rclw	$1, %dx
	jnc	.Ld_lo_t
	subw	%cx, %dx
	stc
	jmp	.Ld_lo_q
.Ld_lo_t:
	cmpw	%cx, %dx
	jb	.Ld_lo_0
	subw	%cx, %dx
	stc
	jmp	.Ld_lo_q
.Ld_lo_0:
	clc
.Ld_lo_q:
	rclw	$1, %di			/* quotient <<= 1 | CF */
	decw	%bp
	jnz	.Ld_lo
	movw	%di, %ax
	popw	%bp
	popw	%di
	popw	%si
	popw	%bx
	ret

/* AX = seconds since boot (uses 32-bit tick delta) */
get_ticks:
	pushw	%es
	pushw	%cx
	pushw	%bx
	movw	$0x0040, %ax
	movw	%ax, %es
	movw	%es:0x6C, %bx		/* tick counter now (lo) */
	movw	%es:0x6E, %cx		/* tick counter now (hi) */
	movw	BTICKL, %ax
	subw	%ax, %bx		/* subtract boot snapshot */
	movw	BTICKH, %ax
	sbbw	%ax, %cx
	movw	%cx, %dx
	movw	%bx, %ax
	movw	$18, %cx
	call	div32_16		/* AX = seconds (approx) */
	popw	%bx
	popw	%cx
	popw	%es
	ret

/* AX = seconds -> prints HH:MM:SS */
print_hms:
	pushw	%ax
	xorw	%dx, %dx
	movw	$3600, %cx
	divw	%cx			/* AX = hh, DX = rest */
	pushw	%dx
	call	print_2d
	movb	$':', %al
	call	putc
	popw	%ax
	xorw	%dx, %dx
	movw	$60, %cx
	divw	%cx
	pushw	%dx
	call	print_2d
	movb	$':', %al
	call	putc
	popw	%ax
	call	print_2d
	popw	%ax
	ret

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

/* read one line from COM1 into BUF */
readline:
	movw	$BUF, %di
	xorw	%cx, %cx
	cld
.Lrl_next:
	movw	$0x3FD, %dx		/* LSR: data ready? */
	inb	%dx, %al
	testb	$0x01, %al
	jz	.Lrl_next
	movw	$0x3F8, %dx
	inb	%dx, %al

	cmpb	$0x0D, %al		/* CR = end of line */
	je	.Lrl_end
	cmpb	$0x0A, %al		/* ignore LF */
	je	.Lrl_next
	cmpb	$0x08, %al		/* BS */
	je	.Lrl_bs
	cmpb	$0x7F, %al		/* DEL */
	je	.Lrl_bs
	cmpb	$0x15, %al		/* Ctrl-U: kill line */
	je	.Lrl_kill
	cmpb	$0x03, %al		/* Ctrl-C */
	je	.Lrl_ctrlc
	cmpb	$0x20, %al		/* printable ASCII only */
	jb	.Lrl_next
	cmpb	$0x7E, %al
	ja	.Lrl_next
	cmpw	$120, %cx		/* line too long */
	jae	.Lrl_next
	stosb
	incw	%cx
	call	putc			/* echo */
	jmp	.Lrl_next

.Lrl_bs:
	jcxz	.Lrl_next
	decw	%di
	decw	%cx
	pushw	%ax
	movb	$0x08, %al
	call	sputc
	movb	$0x20, %al
	call	sputc
	movb	$0x08, %al
	call	sputc
	popw	%ax
	jmp	.Lrl_next

.Lrl_kill:
	pushw	%ax
	pushw	%cx
	jcxz	.Lrl_kill_done
.Lrl_kill_sp:
	pushw	%cx
	movb	$0x08, %al
	call	sputc
	movb	$0x20, %al
	call	sputc
	movb	$0x08, %al
	call	sputc
	popw	%cx
	loop	.Lrl_kill_sp
.Lrl_kill_done:
	popw	%cx
	popw	%ax
	movw	$BUF, %di
	xorw	%cx, %cx
	jmp	.Lrl_next

.Lrl_ctrlc:
	pushw	%ax
	call	.Lrl_wipe
	movb	$'^', %al
	call	putc
	movb	$'C', %al
	call	putc
	popw	%ax
	jmp	.Lrl_end

.Lrl_wipe:				/* visually erase CX chars */
	pushw	%cx
	jcxz	.Lrl_wipe_done
.Lrl_wipe_sp:
	pushw	%cx
	movb	$0x08, %al
	call	sputc
	movb	$0x20, %al
	call	sputc
	movb	$0x08, %al
	call	sputc
	popw	%cx
	loop	.Lrl_wipe_sp
.Lrl_wipe_done:
	popw	%cx
	ret

.Lrl_end:
	pushw	%ax
	movb	$0x0D, %al
	call	putc
	movb	$0x0A, %al
	call	putc
	popw	%ax
	xorb	%al, %al
	stosb				/* NUL-terminate */
	ret

/* tokenize BUF; dispatch command from CmdTable */
process_line:
	movw	$BUF, %si
	cmpb	$0, (%si)
	je	.Lpl_done
.Lpl_skip:
	cmpb	$0x20, (%si)
	jne	.Lpl_tok
	incw	%si
	jmp	.Lpl_skip
.Lpl_tok:
	cmpb	$0, (%si)
	je	.Lpl_done
	movw	$TOK, %di
	cld
.Lpl_tok_c:
	movb	(%si), %al
	testb	%al, %al
	jz	.Lpl_tok_end
	cmpb	$0x20, %al
	je	.Lpl_tok_end
	cmpb	$'A', %al		/* lowercase */
	jb	.Lpl_tok_st
	cmpb	$'Z', %al
	ja	.Lpl_tok_st
	addb	$0x20, %al
.Lpl_tok_st:
	stosb
	incw	%si
	jmp	.Lpl_tok_c
.Lpl_tok_end:
	xorb	%al, %al
	stosb
.Lpl_args:
	cmpb	$0x20, (%si)
	jne	.Lpl_save_arg
	incw	%si
	jmp	.Lpl_args
.Lpl_save_arg:
	movw	%si, ARG

	movw	$CmdTable, %bx
.Lpl_scan:
	movw	(%bx), %si		/* command name */
	testw	%si, %si
	jz	.Lpl_unknown
	movw	$TOK, %di
.Lpl_cmp:
	movb	(%si), %al
	cmpb	(%di), %al
	jne	.Lpl_next
	testb	%al, %al
	jz	.Lpl_hit
	incw	%si
	incw	%di
	jmp	.Lpl_cmp
.Lpl_next:
	addw	$6, %bx			/* name + help + handler */
	jmp	.Lpl_scan
.Lpl_hit:
	pushw	4(%bx)
	ret				/* tail-jump to handler */
.Lpl_unknown:
	movw	$MsgUnknown, %si
	call	puts
.Lpl_done:
	ret

/* ------------------------------------------------------------------ */
/* Commands                                                            */
/* ------------------------------------------------------------------ */

do_help:
	movw	$MsgHelpHead, %si
	call	puts
	movw	$CmdTable, %bx
.Ldh_cmd:
	movw	(%bx), %si		/* name */
	testw	%si, %si
	jz	.Ldh_done
	pushw	%bx
	movb	$' ', %al
	call	putc
	movb	$' ', %al
	call	putc
	movw	%si, %dx		/* name start */
.Ldh_name:
	lodsb
	testb	%al, %al
	jz	.Ldh_pad
	call	putc
	jmp	.Ldh_name
.Ldh_pad:
	movw	%dx, %ax
	addw	$9, %ax			/* pad name column to 9 */
	cmpw	%si, %ax
	jbe	.Ldh_help
	movb	$' ', %al
	call	putc
	jmp	.Ldh_pad
.Ldh_help:
	movw	2(%bx), %si		/* help text */
	call	puts
	popw	%bx
	addw	$6, %bx
	jmp	.Ldh_cmd
.Ldh_done:
	ret

do_ver:
	movw	$MsgVersion, %si
	call	puts
	ret

do_echo:
	movw	ARG, %si
	cmpb	$0, (%si)
	je	.Lde_crlf
	call	puts
.Lde_crlf:
	call	crlf
	ret

do_cls:
	pushw	%ax
	pushw	%bx
	pushw	%cx
	pushw	%dx
	movw	$EscClear, %si
	call	sputs			/* ANSI clear on serial console */
	movb	$0x06, %ah		/* BIOS scroll-up = clear (VGA) */
	xorb	%al, %al
	movw	$0x0700, %bx
	xorw	%cx, %cx
	movw	$0x184F, %dx
	int	$0x10
	popw	%dx
	popw	%cx
	popw	%bx
	popw	%ax
	ret

do_mem:
	pushw	%es
	movw	$0x0040, %ax		/* BDA: conventional KB at 0x40:0x13 */
	movw	%ax, %es
	movw	%es:0x13, %cx
	movw	$MsgMemConv, %si
	call	puts
	movw	%cx, %ax
	call	print_dec
	movw	$MsgKB, %si
	call	puts
	movb	$0x88, %ah		/* INT 15h: extended memory KB */
	int	$0x15
	movw	%ax, %cx
	movw	$MsgMemExt, %si
	call	puts
	movw	%cx, %ax
	call	print_dec
	movw	$MsgKB, %si
	call	puts
	movw	$MsgMemTot, %si
	call	puts
	movw	%cx, %ax
	shrw	$10, %ax
	incw	%ax
	addw	%cx, %ax
	shrw	$10, %ax
	call	print_dec
	movw	$MsgMB, %si
	call	puts
	popw	%es
	ret

do_cpu:
	movw	$MsgCpuVendor, %si
	call	puts
	call	cpu_vendor_str
	movw	$TOK, %si
	call	puts
	call	crlf
	movw	$MsgCpuSig, %si
	call	puts
	movw	$1, %ax
	cpuid
	movw	%ax, %cx
	andw	$0x0F, %cx		/* stepping */
	movw	%cx, %ax
	call	print_dec
	movw	$MsgFam, %si
	call	puts
	movw	$1, %ax
	cpuid
	movw	%ax, %cx
	shrw	$4, %cx
	andw	$0x0F, %cx		/* family */
	movw	%cx, %ax
	call	print_dec
	movw	$MsgModel, %si
	call	puts
	movw	$1, %ax
	cpuid
	movw	%ax, %cx
	shrw	$8, %cx
	andw	$0x0F, %cx		/* model */
	movw	%cx, %ax
	call	print_dec
	call	crlf
	ret

/* stores 12-byte CPUID vendor string into TOK */
cpu_vendor_str:
	pushw	%ax
	pushw	%di
	xorw	%ax, %ax
	cpuid
	movw	$TOK, %di
	movl	%ebx, %eax
	stosw
	shrl	$16, %eax
	stosw
	movl	%edx, %eax
	stosw
	shrl	$16, %eax
	stosw
	movl	%ecx, %eax
	stosw
	shrl	$16, %eax
	stosw
	xorb	%al, %al
	stosb
	popw	%di
	popw	%ax
	ret

do_uptime:
	movw	$MsgUptime, %si
	call	puts
	call	get_ticks
	call	print_hms
	call	crlf
	ret

do_time:
	xorb	%ah, %ah
	int	$0x1A			/* CX:DX = ticks since midnight */
	movw	%dx, %ax
	movw	%cx, %dx
	movw	$18, %cx
	call	div32_16		/* AX = seconds since midnight */
	movw	$MsgTime, %si
	call	puts
	call	print_hms
	call	crlf
	ret

do_sysinfo:
	pushw	%es
	movw	$MsgSysHead, %si
	call	puts
	movw	$MsgSysOs, %si
	call	puts
	movw	$MsgSysCpu, %si
	call	puts
	call	cpu_vendor_str
	movw	$TOK, %si
	call	puts
	call	crlf
	movw	$MsgSysMem, %si
	call	puts
	movw	$0x0040, %ax
	movw	%ax, %es
	movw	%es:0x13, %cx
	movw	%cx, %ax
	call	print_dec
	movw	$MsgKBSep, %si
	call	puts
	movb	$0x88, %ah
	int	$0x15
	movw	%ax, %cx
	shrw	$10, %cx
	movw	%cx, %ax
	call	print_dec
	movw	$MsgMBSep, %si
	call	puts
	movw	$MsgSysUp, %si
	call	puts
	call	get_ticks
	call	print_dec
	movw	$MsgSecs, %si
	call	puts
	movw	$MsgSysEnd, %si
	call	puts
	popw	%es
	ret

do_banner:
	movw	$MsgBanner, %si
	call	puts
	ret

do_reboot:
	movw	$MsgReboot, %si
	call	puts
	int	$0x19			/* BIOS bootstrap loader */
	ret

do_halt:
	movw	$MsgHalt, %si
	call	puts
	cli
.Lhalt:
	hlt
	jmp	.Lhalt

/* ------------------------------------------------------------------ */
/* Command table: {name ptr, help ptr, handler} ... {0, 0, 0}          */
/* ------------------------------------------------------------------ */
CmdTable:
	.word	cmd_help,	h_help,	  do_help
	.word	cmd_ver,	h_ver,	  do_ver
	.word	cmd_echo,	h_echo,	  do_echo
	.word	cmd_cls,	h_cls,	  do_cls
	.word	cmd_mem,	h_mem,	  do_mem
	.word	cmd_cpu,	h_cpu,	  do_cpu
	.word	cmd_uptime,	h_uptime, do_uptime
	.word	cmd_time,	h_time,	  do_time
	.word	cmd_sysinfo,	h_sysinfo, do_sysinfo
	.word	cmd_banner,	h_banner, do_banner
	.word	cmd_reboot,	h_reboot, do_reboot
	.word	cmd_halt,	h_halt,	  do_halt
	.word	cmd_poweroff,	h_halt,	  do_halt
	.word	0, 0, 0

cmd_help:	.asciz	"help"
cmd_ver:	.asciz	"ver"
cmd_echo:	.asciz	"echo"
cmd_cls:	.asciz	"cls"
cmd_mem:	.asciz	"mem"
cmd_cpu:	.asciz	"cpu"
cmd_uptime:	.asciz	"uptime"
cmd_time:	.asciz	"time"
cmd_sysinfo:	.asciz	"sysinfo"
cmd_banner:	.asciz	"banner"
cmd_reboot:	.asciz	"reboot"
cmd_halt:	.asciz	"halt"
cmd_poweroff:	.asciz	"poweroff"

h_help:		.asciz	"list available commands\n"
h_ver:		.asciz	"print OS version\n"
h_echo:		.asciz	"print text: echo <message>\n"
h_cls:		.asciz	"clear the screen\n"
h_mem:		.asciz	"show memory map\n"
h_cpu:		.asciz	"show CPU identification\n"
h_uptime:	.asciz	"time since boot\n"
h_time:		.asciz	"guest wall-clock time (RTC)\n"
h_sysinfo:	.asciz	"system summary\n"
h_banner:	.asciz	"redraw the banner\n"
h_reboot:	.asciz	"reboot the virtual machine\n"
h_halt:		.asciz	"halt the CPU (then Power Off in OmniVM)\n"

/* ------------------------------------------------------------------ */
/* Strings                                                             */
/* ------------------------------------------------------------------ */
EscClear:	.asciz	"\033[2J\033[H"

MsgBanner:
	.ascii	"\n"
	.ascii	"      ___       _          ___  ___ \n"
	.ascii	"     / _ \\ _ _ (_)_ _  __ _| _ \\/ __|\n"
	.ascii	"    | (_) | ' \\| | ' \\/ _` |   / (__ \n"
	.ascii	"     \\___/|_||_|_|_||_\\__,_|_|_\\\\___|\n"
	.asciz	"\n"
MsgHello:
	.ascii	" OmniOS 1.0.0 \"Tesseract\" - OmniVM guest operating system\n"
	.ascii	" Serial console on COM1 @ 115200 8N1.  Type 'help' for commands.\n"
	.asciz	"\n"
MsgPrompt:	.asciz	"omni> "
MsgUnknown:	.asciz	"unknown command - type 'help'\n"
MsgHelpHead:	.asciz	"OmniOS commands:\n"
MsgVersion:	.asciz	"OmniOS 1.0.0 (build Sep 2026) - OmniVM Guest Tools\n"
MsgMemConv:	.asciz	"Conventional memory : "
MsgMemExt:	.asciz	"Extended memory     : "
MsgMemTot:	.asciz	"Total (approx)      : "
MsgKB:		.asciz	" KB\n"
MsgKBSep:	.asciz	" KB conventional\n"
MsgMB:		.asciz	" MB\n"
MsgMBSep:	.asciz	" MB extended\n"
MsgSecs:	.asciz	" seconds\n"
MsgCpuVendor:	.asciz	"CPU vendor   : "
MsgCpuSig:	.asciz	"CPU signature: stepping "
MsgFam:		.asciz	", family "
MsgModel:	.asciz	", model "
MsgUptime:	.asciz	"Uptime          : "
MsgTime:	.asciz	"Guest time (RTC): "
MsgSysHead:	.asciz	"--- System Information ---\n"
MsgSysOs:	.asciz	"OS      : OmniOS 1.0.0 (OmniVM guest tools)\n"
MsgSysCpu:	.asciz	"CPU     : "
MsgSysMem:	.asciz	"Memory  : "
MsgSysUp:	.asciz	"Uptime  : "
MsgSysEnd:	.asciz	"---------------------------\n"
MsgReboot:	.asciz	"Rebooting...\n"
MsgHalt:
	.ascii	"The system is halted. It is now safe to close this\n"
	.ascii	"virtual machine (OmniVM: Power Off).\n"
	.asciz	"\n"
