import { Workflow, Job, Step, Checkout, SetupPython } from "@intentius/chant-lexicon-github";

// CI pipeline for lex00/parquet-xet — validates both notebooks execute without errors
// Generated YAML is committed at ../.github/workflows/ci.yml

export const workflow = new Workflow({
  name: "CI",
  on: {
    push: { branches: ["main"] },
    pull_request: { branches: ["main"] },
  },
  permissions: { contents: "read" },
});

export const notebook = new Job({
  "runs-on": "ubuntu-latest",
  timeoutMinutes: 15,
  steps: [
    Checkout({}).step,
    SetupPython({ pythonVersion: "3.11" }).step,
    new Step({
      name: "Install dependencies",
      run: "pip install pyarrow numpy matplotlib jupyter nbconvert",
    }),
    new Step({
      name: "Execute benchmark notebook",
      run: "jupyter nbconvert --to notebook --execute parquet-xet-write-strategy.ipynb --output parquet-xet-write-strategy.ipynb",
    }),
    new Step({
      name: "Execute append-prototype notebook",
      run: "jupyter nbconvert --to notebook --execute append-prototype.ipynb --output append-prototype.ipynb",
    }),
  ],
});
