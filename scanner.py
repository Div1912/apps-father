import os, re, json

projects_dir = '/opt/apps-father/projects'
results = []

DANGEROUS = [
    (r'exec\s*\(\s*req\.', 'exec(req.) - shell from HTTP request'),
    (r'exec\s*\([^)]*?(query|body|params)\s*[\.\[]\s*\w*(cmd|command|exec|run|shell|code)', 'exec() with user cmd/command input'),
    (r'execSync\s*\([^)]*?(query|body|params)\s*[\.\[]\s*\w*(cmd|command|exec|run|shell)', 'execSync() with user input'),
    (r'eval\s*\(\s*req\.', 'eval(req.) - code from HTTP request'),
    (r'eval\s*\([^)]*?(query|body|params)\s*[\.\[]\s*\w*(cmd|command|code|exec)', 'eval() with user code input'),
    (r'spawn\s*\([^)]*?(query|body|params)\s*[\.\[]', 'spawn() with user input'),
    (r'\buseradd\b', 'useradd system command'),
    (r'\buserdel\b', 'userdel system command'),
    (r'\busermod\b.*sudo', 'usermod adding to sudo'),
    (r'bash\s+-i\s*[>&]|bash\s+-c.*req', 'reverse shell pattern'),
    (r'\bnc\s+.*-e\s+/bin', 'netcat reverse shell'),
    (r'chmod\s+777', 'chmod 777'),
    (r'chpasswd', 'chpasswd - changing passwords'),
    (r'echo\s+["\'][^"\']+["\'].*>>\s*/etc/(passwd|shadow|sudoers)', 'writing to /etc/passwd or sudoers'),
    (r'/etc/sudoers', 'modifying sudoers'),
    (r'require\s*\(\s*["\']child_process["\']\s*\)[\s\S]{0,200}exec\s*\([^)]*req', 'child_process.exec from request'),
    (r'Buffer\.from\([^)]+,\s*["\']base64["\']\)[^;]*eval', 'base64 obfuscated eval'),
    (r'process\.env\.AF_INTERNAL_SECRET|process\.env\.ENCRYPTION_KEY|process\.env\.WALLET_MNEMONIC|process\.env\.ADMIN_PASSWORD', 'accessing platform secret env vars'),
    (r'fs\.(readFile|readFileSync)\s*\([^)]*\.env', 'reading .env file'),
    (r'curl\s+.*\|\s*(bash|sh)|wget\s+.*\|\s*(bash|sh)', 'curl/wget pipe to bash'),
]

projects = sorted(os.listdir(projects_dir))
scanned = 0
found = 0

for proj_id in projects:
    for deployment in ['release', 'dev']:
        routes = os.path.join(projects_dir, proj_id, deployment, 'backend', 'routes.js')
        if not os.path.exists(routes):
            continue
        scanned += 1
        try:
            content = open(routes, 'r', errors='ignore').read()
            lines = content.split('\n')
            file_findings = []
            for pattern, desc in DANGEROUS:
                for i, line in enumerate(lines):
                    stripped = line.strip()
                    if stripped.startswith('//') or stripped.startswith('*'):
                        continue
                    if re.search(pattern, line, re.IGNORECASE):
                        already = any(f['line'] == i+1 for f in file_findings)
                        if not already:
                            file_findings.append({
                                'line': i+1,
                                'pattern': desc,
                                'code': stripped[:150]
                            })
            if file_findings:
                found += 1
                results.append({
                    'project': proj_id,
                    'deployment': deployment,
                    'count': len(file_findings),
                    'findings': file_findings
                })
        except Exception as e:
            pass

output = {
    'summary': {
        'total_projects': len(projects),
        'files_scanned': scanned,
        'dangerous_files': found
    },
    'results': sorted(results, key=lambda x: x['count'], reverse=True)
}

print(json.dumps(output, indent=2, ensure_ascii=False))
