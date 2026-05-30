{
  description = "Airbarium backend — Bun + Hono + PostgreSQL + Garage dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            # Runtime
            bun

            # Tooling
            biome
            nodejs_22

            # Local services
            docker-compose
            postgresql_17

            # Helpful CLIs
            gh
            jq
            curl
          ];

          shellHook = ''
            echo "airbarium dev shell — bun $(bun --version), biome $(biome --version), node $(node --version)"
          '';
        };
      });
}
