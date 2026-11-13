{
  description = "OpenChamber — web UI for Pi coding agent sessions";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs =
    {
      self,
      nixpkgs,
      bun2nix,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      version = (builtins.fromJSON (builtins.readFile ./package.json)).version;
    in
    {
      overlays.default = final: _prev: {
        openchamber = self.packages.${final.system}.openchamber;
      };

      packages = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          # The desktop's Electron: the major is read from packages/electron
          # devDependencies ("electron": "^45.0.0") at eval time, so an upstream bump fails
          # evaluation with the next step named instead of reaching the
          # runtime as a startup crash (2.4.0 shipped while the flake still
          # built electron_43, and every desktop launch died on "setZoomMode
          # is not a function"). Only the major is asserted: nixpkgs' minor
          # is allowed to trail the caret range, the same-major headers carry
          # the major's APIs the app's code uses, and they drive the node-pty
          # rebuild either way.
          electronSpec =
            (builtins.fromJSON (builtins.readFile ./packages/electron/package.json)).devDependencies.electron;
          electronMajor = nixpkgs.lib.versions.major (nixpkgs.lib.removePrefix "^" electronSpec);
          electron =
            pkgs.${"electron_${electronMajor}"}
              or (throw "packages/electron pins electron ${electronSpec}, but nixpkgs has no electron_${electronMajor}. Pin an older electron in packages/electron or wait for nixpkgs-unstable to carry the major.");
        in
        (rec {
          openchamber = pkgs.callPackage ./nix/package.nix {
            inherit self version;
            bun2nix = bun2nix.packages.${system}.default;
          };
          openchamber-desktop = pkgs.callPackage ./nix/gui.nix {
            inherit self version;
            src = openchamber.passthru.src;
            openchamberCore = openchamber.passthru.core;
            inherit electron;
          };
          gui = openchamber-desktop;
          default = openchamber;
        })
      );

      apps = nixpkgs.lib.genAttrs systems (system: rec {
        openchamber = {
          type = "app";
          program = "${self.packages.${system}.openchamber}/bin/openchamber";
        };
        gui = {
          type = "app";
          program = "${self.packages.${system}.openchamber-desktop}/bin/openchamber-desktop";
        };
        default = openchamber;
      });

      formatter = nixpkgs.lib.genAttrs systems (
        system: nixpkgs.legacyPackages.${system}.nixfmt-rfc-style
      );

      devShells = nixpkgs.lib.genAttrs systems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              bun
              nodejs
              git
              python3
              nixfmt-rfc-style
            ];
          };
        }
      );

      nixosModules = {
        openchamber = import ./nix/module.nix self;
        default = self.nixosModules.openchamber;
      };
    };
}
