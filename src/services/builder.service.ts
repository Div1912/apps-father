import fs from "fs";
import path from "path";
import { GeneratedApp, GeneratedFile } from "../types";

const PROJECTS_DIR = path.join(process.cwd(), "projects");

export class BuilderService {
  getProjectDir(projectId: string): string {
    return path.join(PROJECTS_DIR, projectId);
  }

  async scaffoldProject(projectId: string, app: GeneratedApp): Promise<void> {
    const projectDir = this.getProjectDir(projectId);
    const frontendDir = path.join(projectDir, "frontend");
    const backendDir = path.join(projectDir, "backend");
    const assetsDir = path.join(frontendDir, "assets");

    fs.mkdirSync(frontendDir, { recursive: true });
    fs.mkdirSync(backendDir, { recursive: true });
    fs.mkdirSync(assetsDir, { recursive: true });

    for (const file of app.frontend) {
      this.writeFile(frontendDir, file);
    }

    for (const file of app.backend) {
      this.writeFile(backendDir, file);
    }

    if (app.schema) {
      fs.writeFileSync(path.join(projectDir, "schema.sql"), app.schema, "utf-8");
    }

    const configData = {
      projectId,
      botDescription: app.botDescription,
      botCommands: app.botCommands,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(
      path.join(projectDir, "config.json"),
      JSON.stringify(configData, null, 2),
      "utf-8"
    );

    console.log(`[Builder] Project ${projectId} scaffolded at ${projectDir}`);
  }

  async updateProject(projectId: string, app: GeneratedApp): Promise<void> {
    const projectDir = this.getProjectDir(projectId);
    const frontendDir = path.join(projectDir, "frontend");
    const backendDir = path.join(projectDir, "backend");

    for (const file of app.frontend) {
      this.writeFile(frontendDir, file);
    }

    for (const file of app.backend) {
      this.writeFile(backendDir, file);
    }

    if (app.schema) {
      fs.writeFileSync(path.join(projectDir, "schema.sql"), app.schema, "utf-8");
    }

    console.log(`[Builder] Project ${projectId} updated`);
  }

  getProjectCode(projectId: string): string | null {
    const projectDir = this.getProjectDir(projectId);
    if (!fs.existsSync(projectDir)) return null;

    const result: Record<string, string> = {};

    const readDir = (dir: string, prefix: string) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const filePath = path.join(dir, entry.name);
          result[`${prefix}/${entry.name}`] = fs.readFileSync(filePath, "utf-8");
        }
      }
    };

    readDir(path.join(projectDir, "frontend"), "frontend");
    readDir(path.join(projectDir, "backend"), "backend");

    const schemaPath = path.join(projectDir, "schema.sql");
    if (fs.existsSync(schemaPath)) {
      result["schema.sql"] = fs.readFileSync(schemaPath, "utf-8");
    }

    return JSON.stringify(result, null, 2);
  }

  projectExists(projectId: string): boolean {
    return fs.existsSync(this.getProjectDir(projectId));
  }

  private writeFile(baseDir: string, file: GeneratedFile): void {
    const filePath = path.join(baseDir, file.path);
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, file.content, "utf-8");
  }
}

export const builderService = new BuilderService();
