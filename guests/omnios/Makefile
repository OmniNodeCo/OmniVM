# OmniOS - OmniVM bundled guest operating system
#
# Builds a 1.44 MB bootable floppy image from boot.S using GNU binutils.
# The image must stay under 12 KB of boot+kernel (24 sectors loaded by
# the bootloader); the Makefile enforces this.

AS      = as
LD      = ld
OBJCOPY = objcopy
DD      = dd
STAT    = stat

IMG     = omnios.img
BLOB    = omnios.blob
MAXBLOB = 12288   # 24 sectors * 512 bytes

all: $(IMG)

$(IMG): $(BLOB)
	$(DD) if=/dev/zero of=$@ bs=512 count=2880
	$(DD) if=$(BLOB) of=$@ conv=notrunc

$(BLOB): boot.S
	$(AS) --32 -o boot.o $<
	$(LD) -m elf_i386 -Ttext=0x7C00 -e _start -o boot.elf boot.o
	$(OBJCOPY) -O binary boot.elf $@
	@size=$$($(STAT) -c%s $@); \
	if [ $$size -gt $(MAXBLOB) ]; then \
		echo "ERROR: OmniOS blob is $$size bytes (max $(MAXBLOB))" >&2; \
		exit 1; \
	else \
		echo "OmniOS blob: $$size bytes OK"; \
	fi

clean:
	rm -f $(IMG) $(BLOB) boot.o boot.elf

.PHONY: all clean
