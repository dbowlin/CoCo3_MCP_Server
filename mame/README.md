# Local MAME install (not part of the MCP source)

1. Download an official MAME Windows binary release from [https://www.mamedev.org/](https://www.mamedev.org/)
2. Unzip **into this folder** so you have:
  ```text
   mame/mame.exe
   mame/roms/          ← create if missing (already present)
  ```
3. Copy your ROM sets into `roms/`:
  ```text
   mame/roms/coco3.zip
  ```
   Plus any other sets MAME asks for when you run with `-ext fdc`.
4. Smoke-test from a shell (cwd does not matter if you pass full rompath):
  ```text
   .\mame.exe coco3 -window -ext fdc -rompath roms
  ```

