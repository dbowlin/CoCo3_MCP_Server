# Storage layout

Put CoCo files here so paths stay simple for MCP tools.

```text
storage/
  disks/          ← .dsk images (mount / build output)
  host/
    bas/          ← ASCII BASIC on the PC (for coco_build_disk kind bas)
    bin/          ← machine-language .BIN files
    data/         ← other files to copy onto disks
```

## Examples

Build a disk:

- `dskPath`: `storage/disks/hi.dsk`
- `hostPath`: `storage/host/bas/hi.bas`

Mount it:

- `path`: `storage/disks/hi.dsk`

Paths that start with `storage/` are resolved from the MCP app folder.
