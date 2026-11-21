#!/usr/bin/env python3
"""Reduce private service diagnostics to fixed fields; never print raw errors."""
import json
import pathlib
import sys

BOOLEAN_FIELDS = {
    'mcp_initialized', 'js_tool_discovered', 'chrome_backend_available',
    'stdio_send_initialized_notification', 'launch_agent_installed', 'launch_agent_loaded',
    'launch_agent_running', 'launch_agent_pid_alive', 'health_watch_installed',
    'health_watch_loaded', 'health_watch_ready', 'chrome_discovered', 'user_binding_ready',
    'tabs_api_ready', 'browser_ready', 'tunnel_managed_runtime_process_running',
    'tunnel_process_running', 'launch_agent_owns_process', 'process_running', 'healthy', 'ready',
}
INTEGER_FIELDS = {'browserjack_status_exit', 'browserjack_live_doctor_exit', 'browserjack_user_probe_exit'}
STATUS_ERRORS = {
    'ERROR: LaunchAgent is not using the checked-in tunnel-client launcher. Run: bash scripts/service.sh install': 'installed_checkout_mismatch',
    'ERROR: LaunchAgent is installed but not loaded. Run: bash scripts/service.sh start': 'service_not_loaded',
    'ERROR: LaunchAgent is missing the stdio initialized-notification compatibility mode. Run: bash scripts/service.sh install': 'initialized_notification_missing',
    'ERROR: LaunchAgent is loaded but not running.': 'service_not_running',
    'ERROR: LaunchAgent PID is not alive.': 'service_pid_not_alive',
}


def report(action, text, code):
    if action not in {'doctor', 'smoke', 'status'} or not 0 <= code <= 255:
        raise ValueError('Unsupported check report')
    lines = [f'{action}_exit_code={code}']
    if action == 'doctor':
        try:
            data = json.loads(text)
            if not isinstance(data, dict):
                raise ValueError('Invalid doctor report')
            lines.append('doctor_ready=' + str(data.get('ready') is True).lower())
            checks = data.get('checks', [])
            if isinstance(checks, list):
                for status, field in [('pass', 'passed'), ('warning', 'warning'), ('failure', 'failed')]:
                    count = sum(isinstance(check, dict) and check.get('status') == status for check in checks)
                    lines.append(f'doctor_checks_{field}={count}')
        except (TypeError, ValueError):
            lines.append('doctor_report_unavailable=true')
    else:
        for line in text.splitlines():
            key, separator, value = line.partition('=')
            if separator and ((key in BOOLEAN_FIELDS and value in {'true', 'false'})
                              or (key in INTEGER_FIELDS and value.isascii() and value.isdecimal() and len(value) <= 3)
                              or (key == 'example_title' and value == 'Example Domain')):
                lines.append(line)
        if action == 'status' and code != 0:
            reason = next((STATUS_ERRORS[line] for line in text.splitlines() if line in STATUS_ERRORS), 'check_failed')
            lines.append('status_failure_code=' + reason)
    return '\n'.join(lines) + '\n'


if __name__ == '__main__':
    action, file, code = sys.argv[1:]
    print(report(action, pathlib.Path(file).read_text(errors='replace'), int(code)), end='')
