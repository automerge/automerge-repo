{
  description = "Automerge Repo";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    unstable-nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, unstable-nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        unstable = import unstable-nixpkgs { inherit system; };
        pnpm = "${pkgs.nodePackages.pnpm}/bin/pnpm";

        dev = pkgs.writeShellApplication {
          name = "dev";
          runtimeInputs = [
            pkgs.nodejs_20
            pkgs.pnpm
          ];
          text = ''
            pnpm i --silent
            pnpm dev
          '';
        };

        react_todo_example = pkgs.writeShellApplication {
          name = "react_todo_example";
          runtimeInputs = [
            pkgs.nodejs_20
            pkgs.pnpm
          ];
          text = ''
            cd ./examples/react-todo
            pnpm i --silent
            pnpm dev
          '';
        };

        test_subduction = pkgs.writeShellApplication {
          name = "test_subduction";
          runtimeInputs = [
            pkgs.nodejs_20
            pkgs.pnpm
          ];
          text = "${pnpm} test ./packages/automerge-repo/test/subduction";
        };

      in
        {
          devShell = pkgs.mkShell {
            name = "Automerge Repo Dev Shell";
            formatter = pkgs.alejandra;

            nativeBuildInputs = [
              pkgs.eslint
              pkgs.javascript-typescript-langserver
              pkgs.nodePackages.vscode-langservers-extracted
              pkgs.nodejs_20
              pkgs.pnpm
              pkgs.prettierd
              pkgs.typescript
              pkgs.typescript-language-server
            ];
          };

          packages.default = dev;

          apps.dev = {
            type = "app";
            program = "${dev}/bin/dev";
          };

          apps.react_todo_example = {
            type = "app";
            program = "${react_todo_example}/bin/react_todo_example";
          };

          apps.test_subduction = {
            type = "app";
            program = "${test_subduction}/bin/test_subduction";
          };
        }
    );
}
